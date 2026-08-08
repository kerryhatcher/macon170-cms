import type { Bindings } from "@sonicjs-cms/core";

export const SIGNUP_PERMISSION = "signups.manage";
export const SIGNUP_VERSION = "v1";
export const SIGNUP_UNCONFIRMED_HOURS = 24;
export const SIGNUP_RETENTION_DAYS = 90;
export const SIGNUP_AUDIT_RETENTION_DAYS = 365;
export const SIGNUP_BODY_LIMIT = 8 * 1024;

export type SignupFormType = "rsvp" | "items";
export type SignupFormState = "draft" | "open" | "closed";
export type SignupResponseStatus = "unconfirmed" | "confirmed";

export type SignupBindings = Bindings & {
  APP_VERSION?: string;
  ENVIRONMENT?: string;
  PUBLIC_SITE_ORIGIN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_EXPECTED_ACTION?: string;
  TURNSTILE_EXPECTED_HOSTNAMES?: string;
  INVITE_FROM_EMAIL?: string;
  INVITE_FROM_NAME?: string;
  INVITE_REPLY_TO?: string;
  SIGNUP_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  // The real Cloudflare send_email binding, not a hand-rolled stub. A stub
  // whose send() returned Promise<void> stopped this type from overlapping
  // InviteEmailBindings in request-handler.ts, which forced an
  // `as unknown as` double cast there and silently disabled compile-time
  // checking on the invitation path.
  EMAIL?: SendEmail;
};

export type SignupSlot = {
  id: string;
  formId: string;
  position: number;
  label: string;
  quantityNeeded: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SignupSlotInput = {
  position: number;
  label: string;
  quantityNeeded: number;
  notes: string | null;
};

export type SignupForm = {
  id: string;
  revision: number;
  slug: string;
  eventId: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closesAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SignupFormDetail = SignupForm & { slots: SignupSlot[] };

export type SignupFormInput = {
  slug: string;
  eventId: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closesAt: string | null;
  slots: SignupSlotInput[];
};

export type SignupClaimInput = { slotId: string; quantity: number };

export type SignupResponseInput = {
  email: string;
  familyName: string;
  attending: boolean;
  adults: number;
  children: number;
  dietaryNotes: string | null;
  claims: SignupClaimInput[];
};

export type SignupResponseDetail = {
  id: string;
  formId: string;
  formSlug: string;
  formTitle: string;
  formType: SignupFormType;
  email: string;
  familyName: string;
  attending: boolean;
  adults: number;
  children: number;
  dietaryNotes: string | null;
  status: SignupResponseStatus;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claims: Array<{ slotId: string; label: string; quantity: number }>;
};

export type PublicSignupSlot = {
  id: string;
  label: string;
  notes: string | null;
  quantityNeeded: number;
  quantityClaimed: number;
  quantityRemaining: number;
};

export type PublicSignupForm = {
  slug: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  closed: boolean;
  closesAt: string | null;
  event: { slug: string; title: string; startsAt: string };
  slots: PublicSignupSlot[];
};

export class SignupRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignupRequestError";
  }
}

// decodeURIComponent throws a URIError on invalid percent-encoding (`%zz`).
// Left to reach a generic catch, that turns a malformed path segment into a
// 503 while every unknown or deleted one returns 404 — an enumeration oracle
// on the exact axis the token routes are meant to be uniform about. Every
// path segment in this feature decodes through here.
export function decodeSignupSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SignupRequestError(404, "not_found", "Signup not found.");
  }
}

export class SignupConflictError extends Error {}
export class SignupNotFoundError extends Error {}
export class SignupSlotFullError extends Error {}

const formTypes = new Set<SignupFormType>(["rsvp", "items"]);
const formStates = new Set<SignupFormState>(["draft", "open", "closed"]);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(field: string): never {
  throw new SignupRequestError(400, "validation", `Invalid ${field}`);
}

function text(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") invalid(field);
  const normalized = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (normalized.length < min || normalized.length > max) invalid(field);
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, field, 1, max);
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 20
  ) {
    invalid(field);
  }
  return parsed;
}

function instant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    invalid(field);
  }
  return new Date(value).toISOString();
}

function boolish(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === 1;
}

export function validateSignupFormInput(
  input: Record<string, unknown>,
): SignupFormInput {
  const slug = text(input.slug, "slug", 2, 80);
  if (!slugPattern.test(slug)) invalid("slug");

  const formType = input.formType;
  if (typeof formType !== "string" || !formTypes.has(formType as SignupFormType)) {
    invalid("formType");
  }
  const state = input.state;
  if (typeof state !== "string" || !formStates.has(state as SignupFormState)) {
    invalid("state");
  }

  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  const slots: SignupSlotInput[] =
    formType === "rsvp"
      ? []
      : rawSlots.map((entry, index) => {
          const slot = (entry ?? {}) as Record<string, unknown>;
          const quantityNeeded =
            typeof slot.quantityNeeded === "string"
              ? Number(slot.quantityNeeded)
              : slot.quantityNeeded;
          if (
            typeof quantityNeeded !== "number" ||
            !Number.isInteger(quantityNeeded) ||
            quantityNeeded < 1 ||
            quantityNeeded > 500
          ) {
            invalid("quantityNeeded");
          }
          return {
            position: index,
            label: text(slot.label, "label", 1, 120),
            quantityNeeded,
            notes: optionalText(slot.notes, "notes", 300),
          };
        });
  if (formType === "items" && slots.length === 0) {
    throw new SignupRequestError(
      400,
      "validation",
      "An item signup needs at least one item.",
    );
  }
  if (slots.length > 60) invalid("slots");

  return {
    slug,
    eventId: text(input.eventId, "eventId", 1, 64),
    formType: formType as SignupFormType,
    // A form title is one line. text() preserves newlines on purpose, because
    // instructions need them, but the title is interpolated into the email
    // Subject field, so collapse them here rather than trusting whatever the
    // send_email binding does with a control character in a header field.
    title: text(input.title, "title", 2, 120).replace(/\n+/g, " "),
    instructions: optionalText(input.instructions, "instructions", 2_000) ?? "",
    state: state as SignupFormState,
    closesAt:
      input.closesAt === null ||
      input.closesAt === undefined ||
      input.closesAt === ""
        ? null
        : instant(input.closesAt, "closesAt"),
    slots,
  };
}

export function validateSignupResponseInput(
  raw: Record<string, unknown>,
  form: { formType: SignupFormType; slots: SignupSlot[] },
): SignupResponseInput {
  const email = text(raw.email, "email", 5, 200).toLowerCase();
  if (!emailPattern.test(email)) invalid("email");

  const knownSlots = new Map(form.slots.map((slot) => [slot.id, slot]));
  const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
  const claims: SignupClaimInput[] = [];
  if (form.formType === "items") {
    const seen = new Set<string>();
    for (const entry of rawClaims) {
      const claim = (entry ?? {}) as Record<string, unknown>;
      const slotId = text(claim.slotId, "slotId", 1, 64);
      if (!knownSlots.has(slotId)) invalid("slotId");
      if (seen.has(slotId)) {
        throw new SignupRequestError(
          400,
          "validation",
          "Each item may be claimed once per family.",
        );
      }
      seen.add(slotId);
      const quantity =
        typeof claim.quantity === "string"
          ? Number(claim.quantity)
          : claim.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > (knownSlots.get(slotId)?.quantityNeeded ?? 0)
      ) {
        invalid("quantity");
      }
      claims.push({ slotId, quantity });
    }
  }

  return {
    email,
    familyName: text(raw.familyName, "familyName", 2, 120),
    attending: form.formType === "items" ? true : boolish(raw.attending),
    adults: count(raw.adults ?? 0, "adults"),
    children: count(raw.children ?? 0, "children"),
    dietaryNotes: optionalText(raw.dietaryNotes, "dietaryNotes", 500),
    claims,
  };
}

export function isSignupClosed(
  form: { state: SignupFormState; closesAt: string | null },
  now: number = Date.now(),
): boolean {
  if (form.state !== "open") return true;
  if (!form.closesAt) return false;
  const deadline = Date.parse(form.closesAt);
  return Number.isFinite(deadline) && deadline <= now;
}

export async function hashSignupToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function issueSignupToken(): Promise<{
  token: string;
  tokenHash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { token, tokenHash: await hashSignupToken(token) };
}
