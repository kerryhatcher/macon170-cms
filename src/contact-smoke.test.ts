import { describe, expect, it, vi } from "vitest";

import { ALLOWED_GRADES, ALLOWED_TOPICS } from "./contact";
import { smokeContact } from "./contact-smoke";

const values = (items: readonly string[]) =>
  items.map((value) => ({ label: value || "Choose a grade", value }));

describe("contact deployment smoke", () => {
  it("checks schema, CORS, missing-token rejection, and login protection", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "default-contact-form",
            name: "contact",
            settings: { version: "pack-contact-v1" },
            schema: {
              components: [
                { key: "parentName" },
                { key: "email" },
                { key: "phone" },
                {
                  key: "childGrade",
                  data: { values: values(ALLOWED_GRADES) },
                },
                {
                  key: "topic",
                  data: { values: values(ALLOWED_TOPICS) },
                },
                { key: "message" },
                { key: "website" },
                { key: "submit" },
              ],
            },
          },
          {
            headers: {
              "Access-Control-Allow-Origin":
                "https://www.macon170.com",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin":
              "https://www.macon170.com",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            error: {
              code: "security",
              message: "Complete the security check before submitting.",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://cms.macon170.com/auth/login?returnTo=%2Fadmin%2Fforms%2Fdefault-contact-form%2Fsubmissions",
          },
        }),
      );

    await expect(
      smokeContact({
        baseUrl: "https://cms.macon170.com",
        publicOrigin: "https://www.macon170.com",
        fetchImpl,
      }),
    ).resolves.toEqual({
      contactFormVersion: "pack-contact-v1",
      contactFieldCount: 8,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
