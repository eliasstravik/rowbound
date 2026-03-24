import { describe, expect, it } from "vitest";
import {
  resolveObject,
  resolveTemplate,
  resolveTemplateEscaped,
} from "../template.js";

describe("resolveTemplate", () => {
  const context = {
    row: { email: "test@example.com", name: "Alice", company: "Acme" },
    env: { API_KEY: "sk-123", BASE_URL: "https://api.example.com" },
  };

  it("resolves {{row.x}} placeholders", () => {
    expect(resolveTemplate("Hello {{row.name}}", context)).toBe("Hello Alice");
  });

  it("resolves {{env.X}} placeholders", () => {
    expect(resolveTemplate("Key: {{env.API_KEY}}", context)).toBe(
      "Key: sk-123",
    );
  });

  it("resolves mixed row and env placeholders", () => {
    const template = "{{env.BASE_URL}}/lookup?email={{row.email}}";
    expect(resolveTemplate(template, context)).toBe(
      "https://api.example.com/lookup?email=test@example.com",
    );
  });

  it("resolves multiple placeholders of the same type", () => {
    expect(resolveTemplate("{{row.name}} at {{row.company}}", context)).toBe(
      "Alice at Acme",
    );
  });

  it("returns empty string for missing row variables", () => {
    expect(resolveTemplate("{{row.missing}}", context)).toBe("");
  });

  it("returns empty string for missing env variables", () => {
    expect(resolveTemplate("{{env.MISSING}}", context)).toBe("");
  });

  it("resolves {{x}} shorthand as row variable", () => {
    expect(resolveTemplate("Hello {{name}}", context)).toBe("Hello Alice");
  });

  it("resolves mixed shorthand and prefixed placeholders", () => {
    expect(resolveTemplate("{{name}} key={{env.API_KEY}}", context)).toBe(
      "Alice key=sk-123",
    );
  });

  it("returns empty string for missing shorthand variables", () => {
    expect(resolveTemplate("{{missing}}", context)).toBe("");
  });

  it("leaves plain strings unchanged", () => {
    expect(resolveTemplate("no placeholders here", context)).toBe(
      "no placeholders here",
    );
  });

  it("handles empty string template", () => {
    expect(resolveTemplate("", context)).toBe("");
  });
});

describe("resolveTemplateEscaped", () => {
  const context = {
    row: { name: "Alice", evil: "$(rm -rf /)" },
    env: { KEY: "sk-123" },
  };

  const mockEscape = (value: string) => `[${value}]`;

  it("applies escape function to resolved row values", () => {
    expect(
      resolveTemplateEscaped("echo {{row.name}}", context, mockEscape),
    ).toBe("echo [Alice]");
  });

  it("applies escape function to resolved env values", () => {
    expect(resolveTemplateEscaped("key={{env.KEY}}", context, mockEscape)).toBe(
      "key=[sk-123]",
    );
  });

  it("does NOT escape static template parts", () => {
    expect(
      resolveTemplateEscaped(
        "curl -s https://api.com/{{row.name}}",
        context,
        mockEscape,
      ),
    ).toBe("curl -s https://api.com/[Alice]");
  });

  it("applies escape function to potentially dangerous values", () => {
    expect(
      resolveTemplateEscaped("echo {{row.evil}}", context, mockEscape),
    ).toBe("echo [$(rm -rf /)]");
  });

  it("escapes empty string for missing values", () => {
    expect(
      resolveTemplateEscaped("echo {{row.missing}}", context, mockEscape),
    ).toBe("echo []");
  });

  it("applies escape function to shorthand variables", () => {
    expect(resolveTemplateEscaped("echo {{name}}", context, mockEscape)).toBe(
      "echo [Alice]",
    );
  });
});

describe("resolveObject", () => {
  const context = {
    row: { email: "test@example.com", domain: "example.com" },
    env: { KEY: "abc" },
  };

  it("resolves strings", () => {
    expect(resolveObject("{{row.email}}", context)).toBe("test@example.com");
  });

  it("resolves nested objects", () => {
    const obj = {
      headers: {
        Authorization: "Bearer {{env.KEY}}",
        "X-Custom": "static",
      },
      body: {
        email: "{{row.email}}",
        nested: {
          domain: "{{row.domain}}",
        },
      },
    };
    expect(resolveObject(obj, context)).toEqual({
      headers: {
        Authorization: "Bearer abc",
        "X-Custom": "static",
      },
      body: {
        email: "test@example.com",
        nested: {
          domain: "example.com",
        },
      },
    });
  });

  it("resolves arrays", () => {
    const arr = ["{{row.email}}", "{{env.KEY}}", "static"];
    expect(resolveObject(arr, context)).toEqual([
      "test@example.com",
      "abc",
      "static",
    ]);
  });

  it("passes through numbers and booleans", () => {
    expect(resolveObject(42, context)).toBe(42);
    expect(resolveObject(true, context)).toBe(true);
    expect(resolveObject(null, context)).toBe(null);
  });

  it("handles mixed nested structures", () => {
    const obj = {
      items: [{ email: "{{row.email}}" }, { count: 5 }],
    };
    expect(resolveObject(obj, context)).toEqual({
      items: [{ email: "test@example.com" }, { count: 5 }],
    });
  });
});
