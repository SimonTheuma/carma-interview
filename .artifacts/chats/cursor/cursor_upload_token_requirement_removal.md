# Upload token requirement removal
_Exported on 10/28/2026 at 21:53:36 GMT+1 from Cursor (3.20.17)_

---

**User**

can we remove the requirement for an upload token when passing a json file? this is a proof of concept so we don't really need it.

---

**Cursor**

I'll look through the codebase for where upload tokens are required for JSON file uploads so we can plan removing that for the PoC.

Reading the auth gate, upload form, and related config so the plan matches how the token is wired today.

Clear picture: upload is gated on a shared bearer token in auth, UI, and config. Planning a PoC-friendly removal of that requirement.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

I'll implement the plan now—starting with opening upload auth and fixing the rate-limit key.

Upload no longer requires a token for the PoC.

**Auth / API:** `authorizeUpload` only checks `UPLOAD_ENABLED`. Rate limiting uses a fixed `"upload"` key instead of a token hash.

**UI:** Token field and `Authorization` header removed from the upload form; page/limits enable when upload is on (not when a token is configured).

**Docs / tests:** README curl no longer uses Bearer; unit/e2e/harness tests updated. Related unit tests pass.

---

**User**

ran into this error during the build step:

3.358   Running TypeScript ...
5.897 src/lib/upload/run.ts(209,22): error TS2304: Cannot find name 'createHash'.
5.910 Failed to type check.
5.910

---

**Cursor**

There's still a `createHash` use in `run.ts` after the import was removed — I'll fix that.

Restored the `createHash` import in `run.ts` — it’s still used for `file_sha256` in the success log. Rebuild should get past that TypeScript error.

