// Single source of truth for "is this string a syntactically valid EVM
// address" - lowercase-or-checksummed hex, no ENS/short-form support. Used
// on both client and server, so this file must stay free of any
// "use client"-incompatible or server-only imports (no next/server, no
// server-only env reads) - the same constraint lib/holderMessage.ts and
// lib/adminMessage.ts already documented for themselves before this was
// pulled out from both.
export const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
