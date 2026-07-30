import { smokeCalendar } from "../src/calendar-smoke.ts";

const result = await smokeCalendar({
  baseUrl: process.env.CMS_BASE_URL ?? "https://cms.macon170.com",
  publicOrigin:
    process.env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com",
});

console.log(JSON.stringify({ status: "ok", ...result }));
