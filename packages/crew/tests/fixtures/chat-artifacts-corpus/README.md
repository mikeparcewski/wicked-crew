# Chat artifacts eval corpus (DES-CHAT-ARTIFACTS-001)

48 labelled chat messages for the per-message decision of DES §4.1. Slice A1 builds it; slice A2 runs it against
real seats (in crew's test configuration, on a disposable daemon, one chat at a time).

- `corpus.json`: `intents` (8), `artifacts` (the open artifacts the messages refer to, each with its fixture HTML and
  the version the person is looking at), `runs` (the run ids the messages name), and `messages`.
- Each message: `id`, `intent`, `open` (the artifact ref open on the surface it is sent from, or `null`), `text` (the
  person's words, verbatim), optional `anchors` (`data-wid`s selected), optional `madeInChat` (artifact refs the chat
  made before this message), and `expect`:
  - `proposal: null` for information, ambiguous, can't and code-change messages, and for a demo with no usable address;
  - `proposal.kind` `entry` (with the catalog `entry` id, the expected `sources` when the message names any, and a
    demo's `url`), `refine` (with the target ref) or `theme` (with the keys it `changes`) otherwise;
  - `reply` says what the answer must do instead (answer, one choose ask, one sentence and the nearest thing studio
    can make, today's code path).
- Every intent has 6 messages: 3 with an artifact open and 3 without. `tests/chat-artifacts-corpus.test.ts` keeps it
  that way and checks each fixture against the outline crew builds.

Send a message with its artifact as studio would: `POST /chats/:id/messages {text, context: {artifact: {ref, version,
anchors}}}`, with the fixture HTML as that version of the document.
