import type { CollectionConfig } from "@sonicjs-cms/core";

/**
 * Family-calendar records. SonicJS `status` is the publication state; the
 * `eventStatus` field is the logistics status shown to families.
 */
export default {
  name: "calendar-event",
  displayName: "Pack calendar event",
  description: "A Pack 170 event. Publish only approved family logistics.",
  icon: "📅",
  schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        title: "Title",
        required: true,
        minLength: 3,
        maxLength: 160,
      },
      slug: {
        type: "slug",
        title: "Stable URL slug",
        required: true,
        minLength: 2,
        maxLength: 80,
      },
      summary: {
        type: "textarea",
        title: "Summary",
        required: true,
        minLength: 10,
        maxLength: 500,
      },
      description: {
        type: "textarea",
        title: "Description",
        required: true,
        minLength: 10,
        maxLength: 8000,
      },
      category: {
        type: "select",
        title: "Category",
        required: true,
        enum: ["pack", "den", "family"],
      },
      eventStatus: {
        type: "select",
        title: "Event status",
        required: true,
        default: "scheduled",
        enum: ["scheduled", "tentative", "cancelled"],
      },
      startsAt: { type: "datetime", title: "Starts at", required: true },
      endsAt: { type: "datetime", title: "Ends at" },
      timezone: {
        type: "string",
        title: "Timezone",
        required: true,
        default: "America/New_York",
      },
      locationName: { type: "string", title: "Location", maxLength: 200 },
      address: { type: "string", title: "Address", maxLength: 300 },
      audience: {
        type: "string",
        title: "Audience",
        required: true,
        minLength: 2,
        maxLength: 300,
      },
      whatToBring: {
        type: "textarea",
        title: "What to bring",
        maxLength: 2000,
      },
      cost: { type: "string", title: "Cost", maxLength: 500 },
      registrationUrl: {
        type: "url",
        title: "Registration URL",
        maxLength: 2000,
      },
      milestone: {
        type: "select",
        title: "Program milestone",
        enum: ["lego-derby", "fall-camp", "pinewood-derby", "blue-gold"],
      },
      legacyEventId: {
        type: "string",
        title: "Legacy event ID",
        required: true,
        maxLength: 36,
        helpText: "Imported immutable ID used by calendar subscriptions.",
      },
      adapterRevision: {
        type: "number",
        title: "Calendar revision",
        required: true,
        default: 0,
        min: 0,
        helpText: "Adapter-controlled revision used for iCalendar SEQUENCE.",
      },
    },
    required: [
      "title",
      "slug",
      "summary",
      "description",
      "category",
      "eventStatus",
      "startsAt",
      "timezone",
      "audience",
      "legacyEventId",
      "adapterRevision",
    ],
  },
  listFields: ["title", "slug", "category", "eventStatus", "startsAt"],
  searchFields: ["title", "slug", "summary"],
  defaultSort: "startsAt",
  defaultSortOrder: "asc",
} satisfies CollectionConfig;
