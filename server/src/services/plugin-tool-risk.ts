/** Plugin discovery and execution share this classification; policy is still enforced per call. */
export function inferPluginToolRisk(toolName: string): "read" | "write" | "destructive" {
  const lower = toolName.toLowerCase();
  if (
    /\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(lower)
  ) return "destructive";
  if (
    /\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(lower)
    || /(^|:)(add|assign|reply|resolve|unresolve|request|upload|link|unlink)([._-]|$)/.test(lower)
  ) return "write";
  return "read";
}
