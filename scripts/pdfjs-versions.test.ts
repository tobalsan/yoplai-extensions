import { describe, expect, it } from "vitest";

import { checkPdfjsVersions } from "./pdfjs-versions.mjs";

describe("PDF.js version compatibility", () => {
  it("accepts matching extension, worker and gateway versions", () => {
    expect(() => checkPdfjsVersions({
      apiVersion: "5.4.296", workerVersion: "5.4.296", gatewayVersion: "5.4.296",
    })).not.toThrow();
  });

  it("fails closed when the gateway version cannot be determined", () => {
    expect(() => checkPdfjsVersions({
      apiVersion: "5.4.296", workerVersion: "5.4.296", gatewayVersion: undefined,
    })).toThrow(/gateway.*unknown.*GATEWAY_ROOT.*GATEWAY_PDFJS_VERSION/);
  });

  it("rejects an API/worker mismatch and names both versions", () => {
    expect(() => checkPdfjsVersions({
      apiVersion: "5.4.296", workerVersion: "5.6.205", gatewayVersion: "5.4.296",
    })).toThrow(/API 5\.4\.296; worker 5\.6\.205/);
  });

  it("rejects a gateway mismatch and names both versions", () => {
    expect(() => checkPdfjsVersions({
      apiVersion: "5.6.205", workerVersion: "5.6.205", gatewayVersion: "5.4.296",
    })).toThrow(/extensions 5\.6\.205; gateway 5\.4\.296/);
  });
});
