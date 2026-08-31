# A4 freeze rebind after live stage-only

**Previous freeze HEAD:** `6362e4abcd8b884cace9b13bcfce5c5a5097cb5b`  
**New freeze HEAD:** `bc466a87b4a45dcb3df518c5533d92e9bcdcbc55`  
**Reason:** A5 required a real `stage-only` executor; that commit supersedes the A3 cutover freeze for staging identity.  
**Plan SHA (unchanged):** `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`

A5 remains blocked on Mac `_wtcompare` + passwordless `sudo -n -u _wtcompare` until an operator provisions it. Linux `_wtcompare` is already provisioned. Throwaway stage-only probe exits `65` / `REFUSED/STALE_OR_INVALID_STAGING` on Mac identity miss (fail-closed; no synthetic receipt).
