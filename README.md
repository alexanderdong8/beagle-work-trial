# Air Filter Shipment System

## Overview

You will build a shipment management system for a renters insurance company that ships air filters to eligible tenants. The system handles the full lifecycle of air filter shipments: determining eligibility, exporting shipment orders to a shipping partner, and importing tracking data back from that partner.

Plan to spend **4–6 hours** on this project. We are not expecting a production-ready system, but we do expect clean, readable code, reasonable technical decisions, and some explanation of tradeoffs you made along the way.

---

## Getting Started

A SQLite database (`database.db`), a property configuration file (`properties.json`), and a ShipStation export (`shipstation-export.csv`) are provided in the repository — you do not need to create or seed any data.

**Provided data:**

- `database.db` — contains `tenants`, `enrollments`, and `historical_shipments` tables with realistic data already loaded.
- `properties.json` — contains property shipment intervals and tenant/property assignments.
- `shipstation-export.csv` — a ShipStation shipment export to be used for the import requirement (see Requirement 4 below).

The supplemental fixture data is also captured in `fixtures/supplemental-fixtures.sql`. If you need to re-apply those fixtures, run `npm run seed-fixtures`.

The fixture data is intentionally a little messy in the way operational data often is. These are not meant to be trick questions. Use reasonable defaults, avoid guessing when confidence is low, and document the assumptions behind your decisions.

The `scripts/` directory contains a couple of rough utilities from an earlier prototype. You may use, modify, or replace them.

---

## The Domain

The company manages **Properties** (rental buildings or units), **Tenants** (individuals who live at a property), and **Enrollments** (insurance products held by a tenant).

- A **Tenant** belongs to a **Property** and may have multiple **Enrollments**.
- An **Enrollment** has a coverage type and a `riders` field (a list of add-on products). In the provided data, the coverage type is stored in the `product` column.
- A Tenant is eligible to receive an air filter if they have at least one active Enrollment where:
  - coverage type / `product` is `"Renters Kit"`, **and**
  - `riders` contains an air-filter delivery rider. The fixture data includes rider labels such as `"Free Airfilters Delivery"` and `"Airfilters Delivery ($4)"`; document how you normalize these labels.

---

## Requirements

### 1. Data Model

Extend the provided schema to support the full system. You will need to add tables for at minimum:

- **Property** — a building or address where tenants live. Properties have a configurable shipment interval (in days) that controls how frequently tenants at that property are eligible to receive a new filter.
- **Shipment** — a record of a filter being shipped to a Tenant, including at minimum a shipment date and a tracking number.

The `tenants`, `enrollments`, and `historical_shipments` tables are already present in `database.db` — do not drop or re-seed them. You may use `historical_shipments` directly or normalize it into your own shipment model if that better fits your design.

Use `properties.json` as the source of property shipment intervals. Choose a reasonable fallback approach for property data that cannot be applied cleanly, and explain it in your README.

---

### 2. Eligibility Engine

Implement logic to determine which tenants are eligible to receive a shipment as of `2026-04-24`. A tenant is eligible if:

1. They have at least one **active** Enrollment with coverage type / `product = "Renters Kit"` and an air-filter delivery rider in their riders list.
2. They have **not** received a shipment within the number of days defined by their Property's shipment interval. Tenants who have never received a shipment are eligible.

Expose this logic through whatever interface makes sense for your implementation — an API endpoint, a service object, a CLI command, etc.

---

### 3. Shipment Export

Provide a way to generate a CSV of eligible tenants to be sent to the shipping partner. Each row should contain, at minimum:

- Recipient name
- Recipient address
- Any other fields you think would be useful

When a shipment batch is exported, record the export so that those tenants are not immediately re-exported in the next batch. Think carefully about what "recording an export" means for eligibility — a shipment has been *ordered*, but not necessarily *delivered* or *confirmed*. Describe your approach in your write-up.

---

### 4. Shipment Import

A ShipStation export (`shipstation-export.csv`) is provided in the repository. It contains:

- Recipient name
- Recipient address
- Shipment date
- Tracking number
- One or more filter sizes in `custom_field_1`

Build an import mechanism that ingests this file and matches each row to a Tenant record in your database.

**Matching rules:**

- Attempt to match automatically using the recipient's name, address, or a combination of both. You decide what constitutes a confident automatic match — document your decision.
- Rows that cannot be matched automatically with confidence should be flagged for manual review.

**Filter sizes:**

Each shipment row may include one or more filter sizes in `custom_field_1`. Parse and store these sizes. If size data cannot be used, capture enough information for follow-up without blocking the rest of the shipment import.

**Manual review UI:**

Build a simple interface for resolving unmatched rows. It should display the unmatched row's data alongside candidate Tenant records, and allow a user to confirm a match or dismiss the row. The UI does not need to be polished, but it should be functional.

---

## Deliverables

1. **Working code** in a version-controlled repository.
2. A **README** that includes:
   - How to set up and run the project locally
   - Any assumptions you made about the domain or requirements
   - Tradeoffs you made and why
   - A brief note describing any data issues you found and how your implementation handles them
   - What you would improve or do differently with more time

---

## What We're Looking For

- **Correctness** — does the system behave as specified?
- **Code clarity** — is the code readable and sensibly organized?
- **Judgment** — did you make reasonable decisions in ambiguous areas and explain them?
- **Completeness** — are all four requirements represented, even if some are minimal?

We are *not* grading you on visual design, choice of framework, or lines of code. A simple, well-reasoned implementation beats a complex one that's hard to follow.

Good luck — we look forward to reviewing your work.
