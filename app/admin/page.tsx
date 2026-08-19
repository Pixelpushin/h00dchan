import Link from "next/link";

export const metadata = {
  title: "Admin - h00dchan",
};

const SECTIONS = [
  {
    href: "/admin/notes",
    label: "Notes",
    desc: "Personal scratchpad / todo list.",
  },
  {
    href: "/admin/ads",
    label: "Ad review",
    desc: "Approve or reject pending paid ad submissions.",
  },
];

export default function AdminHubPage() {
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-2xl flex-col gap-4 px-6 py-8">
        <h1 className="hc-title text-xl">Admin</h1>
        <div className="flex flex-col gap-2">
          {SECTIONS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="hc-box p-4 hover:opacity-90"
            >
              <div className="hc-thread-subject text-sm">{section.label}</div>
              <div className="hc-thread-meta text-xs mt-0.5">
                {section.desc}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
