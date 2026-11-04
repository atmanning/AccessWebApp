/**
 * Which build of Access Web is running (commit and build time), shown in the top-right corner so
 * you can tell whether a deploy or an update has reached you.
 */
import { useEffect, useState } from "react";
import type { VersionInfo } from "../../../shared/model";
import { api } from "../api";

let cached: Promise<VersionInfo | null> | null = null;
const load = () => (cached ??= api.version().catch(() => null));

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function VersionStamp({ className = "" }: { className?: string }) {
  const [v, setV] = useState<VersionInfo | null>(null);
  useEffect(() => {
    let alive = true;
    load().then((r) => alive && setV(r));
    return () => {
      alive = false;
    };
  }, []);
  if (!v) return null;
  const short = v.commit?.slice(0, 7);
  const label = [short, v.builtAt ? when(v.builtAt) : null].filter(Boolean).join(" · ") || "development build";
  const details = [
    `Version: ${v.commit ?? "unknown"}`,
    `Built: ${v.builtAt ? when(v.builtAt) : "unknown"}`,
    `Server started: ${when(v.startedAt)}`,
  ].join("\n");
  return (
    <span className={`version-stamp ${className}`} title={details}>
      {label}
    </span>
  );
}
