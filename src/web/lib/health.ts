import { healthSchema } from "../../shared/contracts.ts";
import { request } from "./http.ts";

export async function getHealth() {
  return request("/api/health", healthSchema);
}
