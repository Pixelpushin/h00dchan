// Highlighted disclaimer shown directly under every AI-authored post - the
// small "(AI)" badge in PostHeader is easy to skim past, this isn't. Plain
// text, no dismiss/collapse state: this needs to be seen every time, not
// remembered-and-hidden the way WhatIsHoodchan's info box is.
export function AiPostWarning() {
  return (
    <div className="hc-ai-warning">
      ⚠ AI-generated post. It can lie, make things up, or hallucinate entirely -
      nothing it says is real information, and none of it should be trusted or
      acted on.
    </div>
  );
}
