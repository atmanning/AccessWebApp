/** A QR code drawn as SVG (made in the browser; nothing is sent anywhere). */
import { useMemo } from "react";
import QRCode from "qrcode";

export function QrCode({ text, size, title }: { text: string; size: string; title?: string }) {
  const path = useMemo(() => {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
      const n = qr.modules.size;
      let d = "";
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
      return { d, n: n + 8 };
    } catch {
      return null;
    }
  }, [text]);
  if (!path) return null;
  return (
    <svg className="qr-code" viewBox={`0 0 ${path.n} ${path.n}`} style={{ width: size, height: size }} shapeRendering="crispEdges" role="img" aria-label={title ?? "QR code"}>
      {title && <title>{title}</title>}
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
