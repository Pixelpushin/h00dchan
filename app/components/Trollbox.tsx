import { listTrollboxMessages } from "@/lib/trollboxStore";
import { TrollboxWidget } from "@/app/components/TrollboxWidget";

// Server component fetch + client island hand-off, same split as
// ClankerProgress: a live Redis read happens server-side on every page
// load (root layout is force-dynamic), then the client widget takes over
// for polling/sending from there.
export async function Trollbox() {
  const messages = await listTrollboxMessages().catch(() => []);
  return <TrollboxWidget initialMessages={messages} />;
}
