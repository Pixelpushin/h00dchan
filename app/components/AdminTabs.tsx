"use client";

// Persistent tab bar across every /admin/* page - before this, each admin
// page was an island with no way to get to another section except going
// all the way back to /admin first. One shared list here (not duplicated
// per page) means a new admin section later is a one-line addition, not a
// new nav to build.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Home" },
  { href: "/admin/notes", label: "Notes" },
  { href: "/admin/ads", label: "Ads" },
  { href: "/admin/costs", label: "Costs" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav
      className="flex gap-2 border-b pb-2 mb-4"
      style={{ borderColor: "var(--hc-box-border)" }}
    >
      {TABS.map((tab) => {
        const active =
          tab.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="hc-badge text-xs"
            style={
              active
                ? {
                    color: "var(--hc-header-to)",
                    borderColor: "var(--hc-header-to)",
                  }
                : undefined
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
