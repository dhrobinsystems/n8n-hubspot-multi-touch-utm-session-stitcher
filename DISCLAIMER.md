# ⚠️ Disclaimer & Limitation of Liability

**Use at your own risk.** The code, workflows, and scripts in this repository (`n8n-hubspot-multi-touch-utm-session-stitcher`) are provided for educational and architectural demonstration purposes. I publish them as a reference implementation, not as a managed product or a professional service.

## 1. No Warranty ("As-Is" Provision)

All software, n8n JSON blueprints (`workflow.json`), and JavaScript modules are provided **"AS IS" and "AS AVAILABLE"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, accuracy of attribution output, and non-infringement. I do not warrant that the code is error-free, that it will run without interruption, or that it is compatible with any particular n8n version, HubSpot portal configuration, or third-party webhook format. Provider payload shapes (Calendly, Chili Piper, product signup systems, web forms) change over time; the adapters in this repository are illustrative and must be verified against your own payloads.

## 2. Data Protection & Privacy Compliance

You are solely responsible for ensuring that your use of this software complies with every data protection and privacy law that applies to you and to the people whose data you process, including but not limited to:

- the EU and UK **General Data Protection Regulation (GDPR / UK GDPR)**,
- the **California Consumer Privacy Act** as amended by the **California Privacy Rights Act (CCPA/CPRA)**,
- the UK **Privacy and Electronic Communications Regulations (PECR)** and the EU ePrivacy rules on cookies and similar technologies,
- and any other regional, national, or sector-specific privacy law.

This covers, among other things: obtaining valid consent before setting tracking cookies or capturing session, UTM, referrer, or click-ID data; establishing a lawful basis for storing that data on CRM records; honouring opt-outs, "Do Not Sell or Share" requests, and deletion and access requests; documenting retention periods; and reviewing whether click identifiers (`gclid`, `fbclid`, `li_fat_id`, `msclkid`) and URLs constitute personal data in your jurisdiction. The engine strips query strings from URLs stored in the touchpoint history as a data-minimisation measure, but that is not a substitute for your own legal review.

## 3. API Rate-Limit & CRM Quota Risk

High-volume webhook bursts can exhaust HubSpot API rate limits and daily quotas, cause throttled (HTTP 429) or failed requests, and delay or drop attribution updates. The `utm_touchpoint_history` property is a text property with a hard character limit; the engine caps the history by count and by serialized length, but misconfiguration can still cause rejected writes or truncated history. Contact search in HubSpot is eventually consistent, which is why the engine uses a two-pass create-then-reconcile flow; under extreme concurrency, duplicate records or ordering anomalies remain possible.

**You must test in an isolated HubSpot developer test account or sandbox portal** with `SANDBOX_MODE=true` and `DRY_RUN=true` before connecting production credentials, and you must monitor API usage after deployment.

## 4. Assumption of Risk & Limitation of Liability

By using, copying, modifying, or deploying any part of this repository, you assume all risk associated with that use. **In no event shall dhRobin Systems or the author (DH Robin) be liable** for any direct, indirect, incidental, special, exemplary, or consequential damages, including but not limited to:

- data overwrites, data loss, or corruption of CRM records or properties;
- attribution discrepancies, misattributed revenue, or incorrect First-Touch or Last-Touch values;
- downstream reporting, forecasting, compensation, or budgeting errors;
- regulatory fines, privacy complaints, or contractual claims;
- API overage charges, service suspensions, or lost business opportunities;

however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence), even if advised of the possibility of such damage.

## 5. Production Testing Required

Treat every CRM property write as one that cannot be undone. Before you set `DRY_RUN=false`, `SANDBOX_MODE=false`, and `ALLOW_PRODUCTION_WRITES=true`:

1. Run the full test suite (`npm test`).
2. Replay representative payloads in dry-run mode and review every planned property write.
3. Run the same payloads against a sandbox or developer test portal and audit the resulting records.
4. Export or back up the affected HubSpot properties.
5. Confirm a rollback plan with whoever owns the CRM.

## 6. Third-Party Services

HubSpot, n8n, Calendly, Chili Piper, and any other product named in this repository are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by, or sponsored by any of them. You are responsible for complying with each service's terms of service, acceptable use policy, rate limits, and security requirements.

---

The software itself is licensed under the MIT License. See [LICENSE](LICENSE). Copyright (c) 2026 dhRobin Systems.
