import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { type CommandEnvelope, InvalidCommand } from "./command-consumer.js";

/**
 * Validates incoming commands against the schemas THIS service owns (commands belong to their
 * consumer). The schemas ship in the image (events/schemas), the same files the tests validate.
 */
export function commandParser(schemasDir = join(import.meta.dirname, "..", "..", "events", "schemas")) {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
  const byType = new Map<string, string>();
  for (const file of readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
    ajv.addSchema(schema);
    if (schema["x-message-kind"] === "command") byType.set(schema.properties.messageType.const, schema.$id);
  }
  return (raw: unknown): CommandEnvelope => {
    const type = (raw as { messageType?: unknown } | null)?.messageType;
    const schemaId = typeof type === "string" ? byType.get(type) : undefined;
    if (!schemaId) throw new InvalidCommand(`unknown command type ${String(type)}`);
    const validate = ajv.getSchema(schemaId)!;
    if (!validate(raw)) throw new InvalidCommand(`schema violation: ${ajv.errorsText(validate.errors)}`);
    return raw as CommandEnvelope;
  };
}
