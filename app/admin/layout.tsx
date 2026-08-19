import { AdminTabs } from "@/app/components/AdminTabs";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex flex-1 w-full max-w-2xl flex-col px-6 py-8">
        <AdminTabs />
        {children}
      </main>
    </div>
  );
}
