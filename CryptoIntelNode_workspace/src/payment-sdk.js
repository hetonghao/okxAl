import { OKXFacilitatorClient as OfficialOKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import {
  paymentMiddleware,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-express";

export {
  ExactEvmScheme,
  paymentMiddleware,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
};

export class OKXFacilitatorClient extends OfficialOKXFacilitatorClient {
  async post(path, bodyObject, { signal } = {}) {
    const body = JSON.stringify(bodyObject);
    const response = await fetch(this.config.baseUrl + path, {
      method: "POST", headers: this.createHeaders("POST", path, body), body, signal,
    });
    if (!response.ok) throw new Error(`OKX ${path.endsWith("verify") ? "verify" : "settle"} failed: ${response.status}`);
    const json = await response.json();
    return json.data ?? json;
  }

  verify(payload, requirements, options) {
    return this.post("/api/v6/pay/x402/verify", {
      x402Version: 2, paymentPayload: payload, paymentRequirements: requirements,
    }, options);
  }

  settle(payload, requirements, options) {
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
    if (this.config.syncSettle !== undefined) body.syncSettle = this.config.syncSettle;
    return this.post("/api/v6/pay/x402/settle", body, options);
  }
}
