import {
  SignupConflictError,
  SignupNotFoundError,
  isSignupClosed,
} from "./signups";
import type {
  PublicSignupForm,
  SignupBindings,
  SignupForm,
  SignupFormDetail,
  SignupFormInput,
  SignupFormState,
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
) {
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
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE signup_forms
         SET revision = revision + 1, slug = ?, event_id = ?, form_type = ?,
             title = ?, instructions = ?, state = ?, closes_at = ?,
             updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(
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
      ),
      // Slots are replaced wholesale. Claims reference slots with ON DELETE
      // CASCADE, so editing the item list after families have claimed items
      // clears those claims; the admin page warns before saving.
      env.DB.prepare(`DELETE FROM signup_slots WHERE form_id = ?`).bind(id),
      ...slotStatements(env, id, input, now),
      recordSignupAudit(env, "form", id, "updated", actorId, {
        slug: input.slug,
        state: input.state,
        slotCount: input.slots.length,
      }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }

  const form = await getSignupFormById(env, id);
  if (!form) throw new SignupNotFoundError("Signup form not found.");
  return form;
}
