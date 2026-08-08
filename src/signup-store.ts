import {
  SignupConflictError,
  SignupNotFoundError,
  SignupSlotFullError,
  isSignupClosed,
} from "./signups";
import type {
  PublicSignupForm,
  SignupBindings,
  SignupForm,
  SignupFormDetail,
  SignupFormInput,
  SignupFormState,
  SignupResponseDetail,
  SignupResponseInput,
  SignupResponseStatus,
  SignupFormType,
  SignupSlot,
} from "./signups";

export type SignupFormSummary = SignupForm & {
  eventTitle: string;
  eventStartsAt: string;
  responseCount: number;
};

type FormRow = {
  id: string;
  revision: number;
  slug: string;
  event_id: string;
  form_type: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closes_at: string | null;
  created_at: number;
  updated_at: number;
};

type SlotRow = {
  id: string;
  form_id: string;
  position: number;
  label: string;
  quantity_needed: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

const formColumns = `
  id, revision, slug, event_id, form_type, title, instructions, state,
  closes_at, created_at, updated_at
`;

// Spelled out rather than derived from formColumns: a join needs every column
// table-qualified, and string-rewriting a column list is how you get a query
// that silently selects the wrong thing.
const qualifiedFormColumns = `
  signup_forms.id, signup_forms.revision, signup_forms.slug,
  signup_forms.event_id, signup_forms.form_type, signup_forms.title,
  signup_forms.instructions, signup_forms.state, signup_forms.closes_at,
  signup_forms.created_at, signup_forms.updated_at
`;

const slotColumns = `
  id, form_id, position, label, quantity_needed, notes, created_at, updated_at
`;

const qualifiedSlotColumns = `
  signup_slots.id, signup_slots.form_id, signup_slots.position,
  signup_slots.label, signup_slots.quantity_needed, signup_slots.notes,
  signup_slots.created_at, signup_slots.updated_at
`;

function rowToForm(row: FormRow): SignupForm {
  return {
    id: row.id,
    revision: row.revision,
    slug: row.slug,
    eventId: row.event_id,
    formType: row.form_type,
    title: row.title,
    instructions: row.instructions,
    state: row.state,
    closesAt: row.closes_at,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rowToSlot(row: SlotRow): SignupSlot {
  return {
    id: row.id,
    formId: row.form_id,
    position: row.position,
    label: row.label,
    quantityNeeded: row.quantity_needed,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function recordSignupAudit(
  env: SignupBindings,
  entityType: "form" | "response",
  entityId: string,
  action: string,
  actorId: string | null,
  detail: Record<string, unknown> = {},
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO signup_audit
       (id, entity_type, entity_id, action, actor_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    entityType,
    entityId,
    action,
    actorId,
    JSON.stringify(detail),
    Date.now(),
  );
}

async function readSlots(
  env: SignupBindings,
  formId: string,
): Promise<SignupSlot[]> {
  const rows = await env.DB.prepare(
    `SELECT ${slotColumns} FROM signup_slots WHERE form_id = ?
     ORDER BY position ASC`,
  )
    .bind(formId)
    .all<SlotRow>();
  return rows.results.map(rowToSlot);
}

export async function getSignupFormById(
  env: SignupBindings,
  id: string,
): Promise<SignupFormDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${formColumns} FROM signup_forms WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<FormRow>();
  if (!row) return null;
  return { ...rowToForm(row), slots: await readSlots(env, row.id) };
}

export async function getSignupFormBySlug(
  env: SignupBindings,
  slug: string,
): Promise<SignupFormDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${formColumns} FROM signup_forms WHERE slug = ? LIMIT 1`,
  )
    .bind(slug)
    .first<FormRow>();
  if (!row) return null;
  return { ...rowToForm(row), slots: await readSlots(env, row.id) };
}

export async function listSignupForms(
  env: SignupBindings,
): Promise<SignupFormSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT ${qualifiedFormColumns},
       calendar_events.title AS event_title,
       calendar_events.starts_at AS event_starts_at,
       (SELECT COUNT(*) FROM signup_responses
         WHERE signup_responses.form_id = signup_forms.id) AS response_count
     FROM signup_forms
     JOIN calendar_events ON calendar_events.id = signup_forms.event_id
     ORDER BY calendar_events.starts_at DESC, signup_forms.slug ASC`,
  ).all<
    FormRow & {
      event_title: string;
      event_starts_at: string;
      response_count: number;
    }
  >();
  return rows.results.map((row) => ({
    ...rowToForm(row),
    eventTitle: row.event_title,
    eventStartsAt: row.event_starts_at,
    responseCount: row.response_count,
  }));
}

export async function getPublicSignupForm(
  env: SignupBindings,
  slug: string,
): Promise<PublicSignupForm | null> {
  const row = await env.DB.prepare(
    `SELECT ${qualifiedFormColumns},
            calendar_events.slug AS event_slug,
            calendar_events.title AS event_title,
            calendar_events.starts_at AS event_starts_at
     FROM signup_forms
     JOIN calendar_events ON calendar_events.id = signup_forms.event_id
     WHERE signup_forms.slug = ? AND signup_forms.state != 'draft'
     LIMIT 1`,
  )
    .bind(slug)
    .first<
      FormRow & {
        event_slug: string;
        event_title: string;
        event_starts_at: string;
      }
    >();
  if (!row) return null;

  const slots = await env.DB.prepare(
    `SELECT ${qualifiedSlotColumns},
       (SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
         WHERE signup_claims.slot_id = signup_slots.id) AS quantity_claimed
     FROM signup_slots
     WHERE signup_slots.form_id = ?
     ORDER BY signup_slots.position ASC`,
  )
    .bind(row.id)
    .all<SlotRow & { quantity_claimed: number }>();

  const form = rowToForm(row);
  return {
    slug: form.slug,
    formType: form.formType,
    title: form.title,
    instructions: form.instructions,
    closed: isSignupClosed(form),
    closesAt: form.closesAt,
    event: {
      slug: row.event_slug,
      title: row.event_title,
      startsAt: row.event_starts_at,
    },
    slots: slots.results.map((slot) => ({
      id: slot.id,
      label: slot.label,
      notes: slot.notes,
      quantityNeeded: slot.quantity_needed,
      quantityClaimed: slot.quantity_claimed,
      quantityRemaining: Math.max(
        0,
        slot.quantity_needed - slot.quantity_claimed,
      ),
    })),
  };
}

function slotStatements(
  env: SignupBindings,
  formId: string,
  input: SignupFormInput,
  now: number,
) {
  return input.slots.map((slot) =>
    env.DB.prepare(
      `INSERT INTO signup_slots
         (id, form_id, position, label, quantity_needed, notes,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      formId,
      slot.position,
      slot.label,
      slot.quantityNeeded,
      slot.notes,
      now,
      now,
    ),
  );
}

export async function createSignupForm(
  env: SignupBindings,
  input: SignupFormInput,
  actorId: string,
): Promise<SignupFormDetail> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO signup_forms
           (id, revision, slug, event_id, form_type, title, instructions,
            state, closes_at, created_at, updated_at)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        input.slug,
        input.eventId,
        input.formType,
        input.title,
        input.instructions,
        input.state,
        input.closesAt,
        now,
        now,
      ),
      ...slotStatements(env, id, input, now),
      recordSignupAudit(env, "form", id, "created", actorId, {
        slug: input.slug,
        formType: input.formType,
      }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }
  const form = await getSignupFormById(env, id);
  if (!form) throw new Error("Created signup form could not be read.");
  return form;
}

export async function updateSignupForm(
  env: SignupBindings,
  id: string,
  input: SignupFormInput,
  expectedRevision: number,
  actorId: string,
): Promise<SignupFormDetail> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new SignupConflictError("Invalid expectedRevision.");
  }
  const existing = await getSignupFormById(env, id);
  if (!existing) throw new SignupNotFoundError("Signup form not found.");
  if (existing.revision !== expectedRevision) {
    throw new SignupConflictError("The signup changed since it was loaded.");
  }

  const now = Date.now();
  try {
    // Phase 1: the guarded revision bump, alone. Two volunteers can both
    // pass the pre-check above starting from the same revision; only one of
    // their WHERE-guarded UPDATEs can actually match a row. Inspecting
    // meta.changes here — before any slot statement runs — is what stops
    // the loser from wiping the winner's slots (and, via the ON DELETE
    // CASCADE on signup_claims.slot_id, the winner's claims).
    const bump = await env.DB.prepare(
      `UPDATE signup_forms
       SET revision = revision + 1, slug = ?, event_id = ?, form_type = ?,
           title = ?, instructions = ?, state = ?, closes_at = ?,
           updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
      .bind(
        input.slug,
        input.eventId,
        input.formType,
        input.title,
        input.instructions,
        input.state,
        input.closesAt,
        now,
        id,
        expectedRevision,
      )
      .run();
    if (Number(bump.meta?.changes ?? 0) === 0) {
      throw new SignupConflictError("The signup changed since it was loaded.");
    }

    // Phase 2: only reached if this call won the revision bump. Slots are
    // replaced wholesale. Claims reference slots with ON DELETE CASCADE, so
    // editing the item list after families have claimed items clears those
    // claims; the admin page warns before saving. Accepted trade-off: if
    // this second batch fails after phase 1 committed, the form carries the
    // new revision with the old slot list — a failed edit the volunteer
    // retries with the fresh revision, not cross-volunteer corruption.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM signup_slots WHERE form_id = ?`).bind(id),
      ...slotStatements(env, id, input, now),
      recordSignupAudit(env, "form", id, "updated", actorId, {
        slug: input.slug,
        state: input.state,
        slotCount: input.slots.length,
      }),
    ]);
  } catch (error) {
    if (error instanceof SignupConflictError) throw error;
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }

  const form = await getSignupFormById(env, id);
  if (!form) throw new SignupNotFoundError("Signup form not found.");
  return form;
}

type ResponseRow = {
  id: string;
  form_id: string;
  email: string;
  family_name: string;
  attending: number;
  adults: number;
  children: number;
  dietary_notes: string | null;
  status: SignupResponseStatus;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
  form_slug: string;
  form_title: string;
  form_type: SignupFormType;
};

type ClaimRow = { slot_id: string; label: string; quantity: number };

const responseSelect = `
  SELECT signup_responses.id, signup_responses.form_id, signup_responses.email,
         signup_responses.family_name, signup_responses.attending,
         signup_responses.adults, signup_responses.children,
         signup_responses.dietary_notes, signup_responses.status,
         signup_responses.confirmed_at, signup_responses.created_at,
         signup_responses.updated_at,
         signup_forms.slug AS form_slug,
         signup_forms.title AS form_title,
         signup_forms.form_type AS form_type
  FROM signup_responses
  JOIN signup_forms ON signup_forms.id = signup_responses.form_id
`;

function isSlotFull(error: unknown): boolean {
  return /signup slot is full/.test(String(error));
}

function isDuplicateEmail(error: unknown): boolean {
  return /UNIQUE constraint failed: signup_responses\.form_id/.test(
    String(error),
  );
}

async function readClaims(
  env: SignupBindings,
  responseId: string,
): Promise<Array<{ slotId: string; label: string; quantity: number }>> {
  const rows = await env.DB.prepare(
    `SELECT signup_claims.slot_id, signup_slots.label, signup_claims.quantity
     FROM signup_claims
     JOIN signup_slots ON signup_slots.id = signup_claims.slot_id
     WHERE signup_claims.response_id = ?
     ORDER BY signup_slots.position ASC`,
  )
    .bind(responseId)
    .all<ClaimRow>();
  return rows.results.map((row) => ({
    slotId: row.slot_id,
    label: row.label,
    quantity: row.quantity,
  }));
}

function rowToResponse(
  row: ResponseRow,
  claims: Array<{ slotId: string; label: string; quantity: number }>,
): SignupResponseDetail {
  return {
    id: row.id,
    formId: row.form_id,
    formSlug: row.form_slug,
    formTitle: row.form_title,
    formType: row.form_type,
    email: row.email,
    familyName: row.family_name,
    attending: row.attending === 1,
    adults: row.adults,
    children: row.children,
    dietaryNotes: row.dietary_notes,
    status: row.status,
    confirmedAt:
      row.confirmed_at === null
        ? null
        : new Date(row.confirmed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    claims,
  };
}

function claimStatements(
  env: SignupBindings,
  responseId: string,
  input: SignupResponseInput,
  now: number,
) {
  return input.claims.map((claim) =>
    env.DB.prepare(
      `INSERT INTO signup_claims
         (id, response_id, slot_id, quantity, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      responseId,
      claim.slotId,
      claim.quantity,
      now,
    ),
  );
}

export async function createSignupResponse(
  env: SignupBindings,
  form: SignupFormDetail,
  input: SignupResponseInput,
  tokenHash: string,
  ipHash: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO signup_responses
           (id, form_id, email, family_name, attending, adults, children,
            dietary_notes, status, confirmed_at, token_hash, ip_hash,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', NULL, ?, ?, ?, ?)`,
      ).bind(
        id,
        form.id,
        input.email,
        input.familyName,
        input.attending ? 1 : 0,
        input.adults,
        input.children,
        input.dietaryNotes,
        tokenHash,
        ipHash,
        now,
        now,
      ),
      ...claimStatements(env, id, input, now),
      recordSignupAudit(env, "response", id, "created", null, {
        formId: form.id,
        claimCount: input.claims.length,
      }),
    ]);
  } catch (error) {
    if (isSlotFull(error)) {
      throw new SignupSlotFullError("A requested item is already covered.");
    }
    if (isDuplicateEmail(error)) {
      throw new SignupConflictError("That email already signed up.");
    }
    throw error;
  }
  return id;
}

export async function findResponseIdByEmail(
  env: SignupBindings,
  formId: string,
  email: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM signup_responses WHERE form_id = ? AND email = ? LIMIT 1`,
  )
    .bind(formId, email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function rotateResponseToken(
  env: SignupBindings,
  responseId: string,
  tokenHash: string,
  actorId: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE signup_responses SET token_hash = ?, updated_at = ? WHERE id = ?`,
    ).bind(tokenHash, now, responseId),
    recordSignupAudit(env, "response", responseId, "link_resent", actorId),
  ]);
}

export async function getResponseByTokenHash(
  env: SignupBindings,
  tokenHash: string,
): Promise<SignupResponseDetail | null> {
  const row = await env.DB.prepare(
    `${responseSelect} WHERE signup_responses.token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<ResponseRow>();
  if (!row) return null;
  return rowToResponse(row, await readClaims(env, row.id));
}

export async function confirmSignupResponse(
  env: SignupBindings,
  responseId: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE signup_responses
       SET status = 'confirmed', confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'unconfirmed'`,
    ).bind(now, now, responseId),
    recordSignupAudit(env, "response", responseId, "confirmed", null),
  ]);
}

export async function updateSignupResponse(
  env: SignupBindings,
  responseId: string,
  input: SignupResponseInput,
): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE signup_responses
         SET family_name = ?, attending = ?, adults = ?, children = ?,
             dietary_notes = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        input.familyName,
        input.attending ? 1 : 0,
        input.adults,
        input.children,
        input.dietaryNotes,
        now,
        responseId,
      ),
      // Claims are replaced inside the same batch. D1 runs a batch in one
      // implicit transaction, so an oversubscribed slot aborts the trigger and
      // rolls back the delete along with it.
      env.DB.prepare(`DELETE FROM signup_claims WHERE response_id = ?`).bind(
        responseId,
      ),
      ...claimStatements(env, responseId, input, now),
      recordSignupAudit(env, "response", responseId, "updated", null, {
        claimCount: input.claims.length,
      }),
    ]);
  } catch (error) {
    if (isSlotFull(error)) {
      throw new SignupSlotFullError("A requested item is already covered.");
    }
    throw error;
  }
}

export async function deleteSignupResponse(
  env: SignupBindings,
  responseId: string,
  actorId: string | null,
): Promise<void> {
  await env.DB.batch([
    // The audit row is written before the delete: signup_audit.entity_id has
    // no foreign key, so the audit must be committed while the response row
    // still exists to describe, and must outlive it after the delete runs.
    recordSignupAudit(env, "response", responseId, "deleted", actorId),
    env.DB.prepare(`DELETE FROM signup_responses WHERE id = ?`).bind(
      responseId,
    ),
  ]);
}

export async function listSignupResponses(
  env: SignupBindings,
  formId: string,
): Promise<SignupResponseDetail[]> {
  const rows = await env.DB.prepare(
    `${responseSelect} WHERE signup_responses.form_id = ?
     ORDER BY signup_responses.created_at ASC`,
  )
    .bind(formId)
    .all<ResponseRow>();
  const details: SignupResponseDetail[] = [];
  for (const row of rows.results) {
    details.push(rowToResponse(row, await readClaims(env, row.id)));
  }
  return details;
}
