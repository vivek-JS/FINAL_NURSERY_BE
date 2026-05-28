/** Escape user input for safe use inside `new RegExp(..., "i")`. */
export default function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
