import type { NextConfig } from "next";
import path from "path";

// A API define a URL base do backend; o CSP precisa liberar connect-src pra ela
// (senão o fetch é bloqueado). Sem a variável, cai no default de desenvolvimento.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3333";

// Content-Security-Policy: o app não usa CDN de script nem estilo externo, só
// o próprio bundle e chamadas à API. O Next (App Router) injeta scripts INLINE
// de hidratação sem nonce, então 'unsafe-inline' em script-src é necessário
// para o app não quebrar; o dev ainda precisa de 'unsafe-eval'. Isto bloqueia
// o vetor principal (carregar script de origem externa) — um endurecimento
// maior (CSP com nonce por requisição) fica como evolução. frame-ancestors
// 'none' impede embutir o site em iframe (clickjacking), além do X-Frame-Options.
const isProd = process.env.NODE_ENV === "production";
const scriptSrc = isProd
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  scriptSrc,
  `connect-src 'self' ${apiUrl}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
