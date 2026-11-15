# Disclaimer & Limitation of Liability

**Project:** `n8n-hubspot-sales-rep-activity-quota-scoreboard`
**Publisher:** DH Robin (dhRobin Systems)
**Applies to:** every file in this repository, including `workflow.json`, `scoreboard.js`, `env.example` and the documentation.

## 1. Purpose

This repository is an educational and architectural reference. It shows one way to read logged sales activity (calls, emails and meetings) from HubSpot, compare it with configurable activity quotas, and post a ranked scoreboard to Slack. It is not a managed service, a sales-performance management product, a compensation system or HR advice.

## 2. "As is", without warranty

The software is provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or implied. This includes, without limitation, warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, completeness and uninterrupted or error-free operation.

## 3. Accuracy of activity counts and scores

Counts come from HubSpot CRM search results and are processed by configurable heuristics:

- only activities with an owner are counted, and email owners are redacted by HubSpot unless the `sales-email-read` scope is granted;
- "connected" calls are inferred from call duration, and meeting counting depends on `MEETING_COUNT_MODE` and meeting outcomes;
- quotas scale by working days and ignore holidays, leave and part-time schedules unless you configure overrides;
- HubSpot search returns at most 10,000 records per query, and activities logged late or edited after the run are not reflected.

Attainment percentages, points and ranks are relative indicators, not a measure of a person's performance or value. **Do not use the scoreboard alone for compensation, commission, disciplinary, performance-review or employment decisions.** Verify figures in HubSpot and apply human judgement.

## 4. Broadcasting to Slack

When `DRY_RUN=false`, the scoreboard is posted to every channel in `SLACK_WEBHOOK_URLS`. Slack messages cannot be recalled from everyone who saw them. The scoreboard names individual reps and shows their activity and attainment. Make sure each destination channel's audience is appropriate, that reps are informed in line with your workplace policies, and that publishing individual metrics is permitted where your employees work (some jurisdictions and works councils restrict it).

## 5. Third-party services

HubSpot, Slack and n8n APIs, scopes, rate limits, subscription requirements and data formats may change at any time without notice. You are responsible for validating the workflow against current documentation, your subscription and your rate limits.

## 6. Data protection and compliance

The workflow processes owner names, owner emails (used only for quota overrides and never posted) and per-person activity counts, which are personal data about employees. You are responsible for complying with the terms of service, acceptable-use policies and security policies of HubSpot, Slack, n8n and any connected service; with data-protection and employment law (for example GDPR, CCPA/CPRA and local workplace-monitoring rules); and with your internal data-classification rules, including retention of n8n execution data.

## 7. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the author, DH Robin, dhRobin Systems or any contributor be liable for any direct, indirect, incidental, special, exemplary, punitive or consequential damages. This includes lost revenue, profit, business, goodwill or data; decisions made on inaccurate or incomplete activity data; employment or compensation disputes; disclosure of information to unintended audiences; and the cost of substitute services. It applies however caused and on any theory of liability, whether in contract, strict liability or tort (including negligence), arising in any way out of the use, misuse, inability to use or deployment of this software, even if advised of the possibility of such damage.

## 8. No affiliation

HubSpot, Slack and n8n are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by or sponsored by any of them. All rep names, owner IDs, team IDs, emails (such as `rep_1@example.com`) and domains in this repository are fictional or placeholders.

## 9. License

The software is licensed under the MIT License (see [LICENSE](LICENSE)). If anything here conflicts with the MIT License, the MIT License governs.

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-sales-rep-activity-quota-scoreboard`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts, including compensation, performance or employment decisions based on the scoreboard.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. Activity counts, quota attainment, points and ranks are not guaranteed to be accurate or complete.
* **Production Testing Required:** Always test thoroughly first with `DRY_RUN=true` enabled (and, ideally, a HubSpot developer test account plus a private test Slack channel) before broadcasting to management or team channels. Treat every posted scoreboard as visible to everyone in the channel and not recallable.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), employment and workplace-monitoring rules, and security policies of HubSpot, Slack and any connected services. That includes granting only the read scopes needed, confirming each channel's audience may see individual rep metrics, and reviewing automated scoreboards.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-sales-rep-activity-quota-scoreboard/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-sales-rep-activity-quota-scoreboard/blob/main/LICENSE).

License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
