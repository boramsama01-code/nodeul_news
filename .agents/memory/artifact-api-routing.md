---
name: Artifact API routing
description: Deployment and preview routing rules for this multi-artifact news monitor.
---

The web artifact should use the managed API artifact on port 8080 for preview and production. A separate development API workflow on another port can race with or be unavailable to the proxied web preview.

**Why:** The managed API artifact remained healthy while the extra 8099 workflow repeatedly timed out, causing the web preview to report a misleading connection failure.

**How to apply:** Keep the web dev command's `API_PORT` aligned with the managed API artifact port, and avoid adding a duplicate API workflow unless the artifact routing is intentionally changed.

The Replit production database may be frozen or have its compute endpoint disabled, which blocks schema-diff checks during publishing. Unpause/unfreeze Development and Production from the Database pane before retrying Publish; do not add runtime or deploy-time DDL.