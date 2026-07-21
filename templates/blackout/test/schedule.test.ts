import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Schedule from "../components/Schedule.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Schedule.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("Schedule renders day headings and time slots", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Schedule, {
    props: {
      heading: "Weekly schedule",
      days: [
        { day: "Monday", slots: [{ time: "6:00 AM", name: "CrossFit" }, { time: "12:00 PM", name: "Open Gym" }] },
        { day: "Tuesday", slots: [{ time: "6:00 AM", name: "Olympic Lifting" }] },
        { day: "Sunday", slots: [] },
      ],
    },
  });
  expect(html).toContain("Monday");
  expect(html).toContain("CrossFit");
  expect(html).toContain("6:00 AM");
  expect(html).toContain("Sunday");
  // token check — source style block must use custom properties only
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});

test("Schedule renders heading when provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Schedule, {
    props: {
      heading: "Weekly schedule",
      days: [{ day: "Monday", slots: [{ time: "9:00 AM", name: "Yoga" }] }],
    },
  });
  expect(html).toContain("Weekly schedule");
});

test("Schedule omits heading element when not provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Schedule, {
    props: {
      days: [{ day: "Monday", slots: [{ time: "9:00 AM", name: "Yoga" }] }],
    },
  });
  expect(html).not.toContain("<h2>");
});

test("Schedule shows rest day label for empty slots", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Schedule, {
    props: {
      days: [{ day: "Sunday", slots: [] }],
    },
  });
  expect(html).toContain("Sunday");
  expect(html).toMatch(/[Rr]est/);
});

test("Schedule renders multiple days as columns", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Schedule, {
    props: {
      days: [
        { day: "Monday", slots: [{ time: "7:00 AM", name: "HIIT" }] },
        { day: "Wednesday", slots: [{ time: "6:00 PM", name: "Strength" }] },
        { day: "Friday", slots: [{ time: "7:00 AM", name: "Cardio" }] },
      ],
    },
  });
  expect(html).toContain("Monday");
  expect(html).toContain("Wednesday");
  expect(html).toContain("Friday");
  expect(html).toContain("HIIT");
  expect(html).toContain("Strength");
  expect(html).toContain("Cardio");
});
