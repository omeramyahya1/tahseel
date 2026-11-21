export type WebhookErrorCode =
  | "webhook_endpoint_not_found"
  | "url_invalid"
  | "too_many_webhook_endpoints";

export class WebhookError extends Error {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}
