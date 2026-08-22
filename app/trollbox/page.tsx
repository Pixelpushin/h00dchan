import { listTrollboxMessages, MAX_MESSAGES } from "@/lib/trollboxStore";
import { TrollboxClient } from "@/app/trollbox/TrollboxClient";

export const dynamic = "force-dynamic";

export default async function TrollboxPage() {
  const messages = await listTrollboxMessages();
  return (
    <div className="flex flex-col flex-1 items-center">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-3 px-6 py-10">
        <h1 className="hc-title text-xl">Trollbox</h1>
        <p className="hc-thread-meta text-sm">
          Live shitposting, no threads, no subjects - just the last{" "}
          {MAX_MESSAGES} messages. Claim an anon to talk.
        </p>
        <TrollboxClient initialMessages={messages} />
      </main>
    </div>
  );
}
