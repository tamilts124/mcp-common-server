"use strict";
// ── JSON_SCHEMA_VALIDATE — validate a JSON file against a JSON Schema file ─
// Hand-rolled subset validator (zero-dependency, no ajv). Supports the
// keywords agents actually reach for: type, required, properties,
// additionalProperties, items, enum, minimum/maximum, minLength/maxLength,
// pattern, minItems/maxItems. Not a full JSON Schema draft implementation
// (no $ref, allOf/anyOf/oneOf, formats) — good enough for validating config
// files / tool-output shapes without pulling in a dependency. Read-only.

const fs = require("fs");
const { ToolError } = require("./errors");

function readJson(absPath, origPath, label) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`json_schema_validate: cannot access ${label} '${origPath}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`json_schema_validate: ${label} '${origPath}' is not a regular file.`, -32602);
  const text = fs.readFileSync(absPath, "utf8");
  try { return JSON.parse(text); }
  catch (e) { throw new ToolError(`json_schema_validate: ${label} '${origPath}' is not valid JSON: ${e.message}`, -32602); }
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object"
}

function matchesType(v, expected) {
  const t = typeOf(v);
  if (expected === "integer") return t === "number" && Number.isInteger(v);
  return t === expected;
}

// Recursively validate `data` against `schema`, pushing {path, message} for
// every violation found (does not short-circuit — collects all errors).
function validateNode(data, schema, path, errors) {
  if (schema == null || typeof schema !== "object") return; // no constraints

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(data, t))) {
      errors.push({ path, message: `expected type ${types.join(" or ")}, got ${typeOf(data)}` });
      return; // further checks would be noise once the base type is wrong
    }
  }

  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(data))) {
    errors.push({ path, message: `value not in enum [${schema.enum.map(v => JSON.stringify(v)).join(", ")}]` });
  }

  if (typeOf(data) === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern) {
      let re;
      try { re = new RegExp(schema.pattern); }
      catch (e) { errors.push({ path, message: `schema pattern is invalid regex: ${e.message}` }); re = null; }
      if (re && !re.test(data)) errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeOf(data) === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({ path, message: `${data} is less than minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({ path, message: `${data} is greater than maximum ${schema.maximum}` });
    }
  }

  if (typeOf(data) === "array") {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      data.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
    }
  }

  if (typeOf(data) === "object") {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) errors.push({ path: path ? `${path}.${key}` : key, message: "required property missing" });
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in data) validateNode(data[key], subSchema, path ? `${path}.${key}` : key, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) errors.push({ path: path ? `${path}.${key}` : key, message: "additional property not allowed by schema" });
      }
    }
  }
}

/**
 * Validate a JSON data file against a JSON Schema file.
 * @returns {{ path, schemaPath, valid, errorCount, errors: [{path, message}] }}
 */
function jsonSchemaValidate(absPath, origPath, absSchemaPath, origSchemaPath) {
  const data = readJson(absPath, origPath, "data file");
  const schema = readJson(absSchemaPath, origSchemaPath, "schema file");
  if (typeOf(schema) !== "object") {
    throw new ToolError(`json_schema_validate: schema file '${origSchemaPath}' must be a JSON object.`, -32602);
  }

  const errors = [];
  validateNode(data, schema, "", errors);

  return {
    path:       origPath,
    schemaPath: origSchemaPath,
    valid:      errors.length === 0,
    errorCount: errors.length,
    errors,
  };
}

module.exports = { jsonSchemaValidate };
