export function checkPdfjsVersions({ apiVersion, workerVersion, gatewayVersion }) {
  if (!workerVersion || workerVersion !== apiVersion) {
    throw new Error(
      `[pdfjs] PDF.js API/worker version mismatch: API ${apiVersion}; worker ${workerVersion ?? "unknown"}. Reinstall dependencies before deploying.`,
    );
  }
  if (!gatewayVersion) {
    throw new Error(
      "[pdfjs] PDF.js gateway version unknown. Set GATEWAY_ROOT to the installed gateway directory or explicitly assert GATEWAY_PDFJS_VERSION before building.",
    );
  }
  if (apiVersion !== gatewayVersion) {
    throw new Error(
      `[pdfjs] PDF.js version mismatch: extensions ${apiVersion}; gateway ${gatewayVersion}. Align the extensions pin with the gateway's pdf-parse dependency before deploying.`,
    );
  }
}
