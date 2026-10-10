import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import { CreatorToolkit } from "./tools.ts";

const hasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(hasDescription));
};

it("exports described object schemas for every Creator tool", () => {
  expect(Object.keys(CreatorToolkit.tools).toSorted()).toEqual([
    "creator_comments",
    "creator_open",
    "creator_resolve",
  ]);
  for (const tool of Object.values(CreatorToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
    };
    expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(hasDescription(fieldSchema), `${tool.name}.${field} description`).toBe(true);
    }
  }
});

it("marks only creator_comments read-only", () => {
  const readOnly = Object.values(CreatorToolkit.tools)
    .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
    .map((tool) => tool.name);
  expect(readOnly).toEqual(["creator_comments"]);
});
