import {
  ALLOWED_GRADES,
  ALLOWED_TOPICS,
  CONTACT_FORM_ID,
  CONTACT_FORM_VERSION,
  CONTACT_QUEUE_PATH,
} from "./contact";

type ContactSmokeOptions = {
  baseUrl: string;
  publicOrigin: string;
  fetchImpl?: typeof fetch;
};

export type ContactSmokeResult = {
  contactFormVersion: string;
  contactFieldCount: number;
};

function check(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export async function smokeContact({
  baseUrl,
  publicOrigin,
  fetchImpl = fetch,
}: ContactSmokeOptions): Promise<ContactSmokeResult> {
  const origin = baseUrl.replace(/\/$/, "");
  const readResponse = (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    fetchImpl(`${origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      ...init,
    });

  const schemaResponse = await readResponse("/api/forms/contact/schema", {
    headers: { Origin: publicOrigin },
  });
  check(
    schemaResponse.status === 200,
    `contact schema returned ${schemaResponse.status}`,
  );
  check(
    schemaResponse.headers.get("access-control-allow-origin") === publicOrigin,
    "contact schema did not return the expected CORS origin",
  );
  const schemaPayload = (await schemaResponse.json()) as {
    id?: unknown;
    name?: unknown;
    settings?: { version?: unknown };
    schema?: { components?: Array<Record<string, unknown>> };
  };
  check(
    schemaPayload.id === CONTACT_FORM_ID &&
      schemaPayload.name === "contact",
    "contact schema returned the wrong form",
  );
  check(
    schemaPayload.settings?.version === CONTACT_FORM_VERSION,
    "contact schema returned the wrong production form version",
  );
  check(
    Array.isArray(schemaPayload.schema?.components),
    "contact schema did not return components",
  );
  const components = schemaPayload.schema.components;
  const keys = new Set(
    components
      .map((component) => component.key)
      .filter((key): key is string => typeof key === "string"),
  );
  for (const field of [
    "parentName",
    "email",
    "phone",
    "childGrade",
    "topic",
    "message",
  ]) {
    check(keys.has(field), `contact schema is missing ${field}`);
  }
  const grade = components.find(
    (component) => component.key === "childGrade",
  ) as
    | { data?: { values?: Array<{ value?: unknown }> } }
    | undefined;
  const topic = components.find(
    (component) => component.key === "topic",
  ) as
    | { data?: { values?: Array<{ value?: unknown }> } }
    | undefined;
  check(
    JSON.stringify(grade?.data?.values?.map(({ value }) => value)) ===
      JSON.stringify(ALLOWED_GRADES),
    "contact schema returned the wrong grade allowlist",
  );
  check(
    JSON.stringify(topic?.data?.values?.map(({ value }) => value)) ===
      JSON.stringify(ALLOWED_TOPICS),
    "contact schema returned the wrong topic allowlist",
  );

  const preflight = await readResponse("/api/forms/contact/submit", {
    method: "OPTIONS",
    headers: {
      Origin: publicOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  check(
    preflight.status === 204,
    `contact preflight returned ${preflight.status}`,
  );
  check(
    preflight.headers.get("access-control-allow-origin") === publicOrigin,
    "contact preflight did not return the expected CORS origin",
  );

  const missingToken = await readResponse("/api/forms/contact/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
    },
    body: JSON.stringify({
      data: {
        parentName: "Smoke Test Parent",
        email: "smoke@example.invalid",
        childGrade: "",
        topic: "Website or privacy question",
        message:
          "This missing-token smoke request must never create a submission.",
      },
    }),
  });
  check(
    missingToken.status === 400,
    `missing-token contact request returned ${missingToken.status}`,
  );
  const missingTokenBody = (await missingToken.json()) as {
    error?: { code?: unknown };
  };
  check(
    missingTokenBody.error?.code === "security",
    "missing-token contact request returned the wrong error",
  );

  const queue = await readResponse(CONTACT_QUEUE_PATH);
  check(queue.status === 302, `contact queue returned ${queue.status}`);
  check(
    queue.headers.get("location") ===
      `${origin}/auth/login?returnTo=${encodeURIComponent(CONTACT_QUEUE_PATH)}`,
    "contact queue did not redirect to the expected login path",
  );

  return {
    contactFormVersion: CONTACT_FORM_VERSION,
    contactFieldCount: components.length,
  };
}
