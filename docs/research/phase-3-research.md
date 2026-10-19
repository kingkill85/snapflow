# Phase 3 research: distribution boards, zone needs, channel assignment, bus checks

Status: research input for the phase 3 spec, 2026-10-19. Not a decision record. It checks the agreed concept (phase-2 spec "Outlook: phase 3", D185–D192, customer PDF "SnapFlow – Distribution boards concept") against existing tools, product data standards, norms and the KNX / HDL Buspro / Zigbee rules.

How sure each finding is: **[verified]** = read in a manufacturer, standard-body or official-tool source. **[secondary]** = distributor, reseller, forum or blog; plausible but check it. **[open]** = not found; ask the customer or the manufacturer.

---

## Executive summary

**Confirmed**

1. **Loads → actuator channels is the established model.** Schneider eConfigure KNX (an ETS app) works the same way: "loads" (non-communicating items such as lights and blinds) sit on the floor plan, a "Loads" panel lists the loads not yet connected (by floor), and the user connects them to actuator outputs automatically, semi-automatically or by hand. Its installation report tells the electrician which load goes on which actuator output. This matches D186/D190 closely. [verified]
2. **Room templates are standard practice.** Hager Ready plans boards "automatically from a room book" (equipment levels from DIN 18015 / RAL-RG 678). Loxone has room types (bedroom, living room, passage) that drive its auto-planning. [verified]
3. **Per-line bus current is what ETS itself checks.** The ETS topology panel adds up the bus current of every device on a line. Where a product's value is missing, ETS **assumes 10 mA** and does not count it as 0. [verified]
4. **The limits in the concept hold:** KNX 640 mA ≈ 64 devices, 350 m from power supply to the farthest device, 700 m between two devices, 1000 m per line. HDL power supplies are 750 / 1200 / 2400 mA; the HDL 6-port switch allows up to 63 devices per bus cable. [verified for KNX; HDL only partly]

**Change**

5. **Empty bus current should warn, not count as 0** (change to D187). Follow ETS: show "bus current unknown for 3 devices" and optionally use a default (KNX 10 mA). Otherwise a half-filled Excel gives a check that looks fine but is wrong.
6. **Don't hard-code "64 devices per line".** KNX TP1-256 (newer couplers) allows up to 256 devices per line. In practice the power supply's mA still sets the limit, and 1280 mA supplies exist. "Max devices" should be a field of the power supply or line product (data, per D187), or a per-system setting. It should not be a constant.
7. **Dimmer limits are not one number per channel.** Datasheets give: a limit per load type × dimming mode (ABB: LED 4×210 W trailing edge, but 4×80 W leading edge), a module total (HDL MDT0601: 6 × 1 A, 6 A total), a higher limit when only one channel is used or channels are combined, a minimum load (≈2–3 W), and derating for heat (ambient temperature, stacked devices). Keep "limit per load type" plus "module total" (already in the concept). Add "minimum load per channel" as an optional field meaning. Show derating and channel combining as a note only (a reserve margin); don't model them.
8. **Recommend a reserve, don't only warn on overflow.** Common practice is 20% (KNX power supply used to at most about 80%; IET guidance and Hager: about 20% spare space in the board; Bangladesh's code (BNBC 2012): 1 spare way per 5 circuits). Add a project/tenant setting "reserve %" that turns the bus-current and rail-space checks amber before they turn red.

**Add**

9. **Rail space as rows × TE per enclosure.** The enclosure (or board) supplies TE in rows (a row is typically 12 TE, sometimes 18 or 24). One TE is 17.5 mm (DIN 43880). KNX datasheets often say "18 mm module", which is the same unit. The same supply/use check applies to TE. A board without an enclosure product just shows "used TE".
10. **ETIM codes as an optional mapping on column meanings,** for later supplier data (BMEcat/ETIM). ETIM covers outputs (EF000319), width in modules (EF002950), mounting method (EF000003), max LED power (EF015953), number of blind outputs (EF001740), rated current (EF000227) and inputs (EF000318/EF001992). ETIM has **no KNX bus current in mA**, and no limit per load type per channel. HDL publishes no ETIM data that I found. Excel columns therefore stay the main source; ETIM is only a convenience.
11. **Store programming data now as plain per-unit fields:** KNX individual address (area.line.device), line, and channel → group function. HDL subnet ID / device ID (0–254 each, device ID unique per subnet) and channel names. Zigbee gateway assignment and IEEE address. ETS can import group addresses as CSV/XML (simple to generate). A full .knxproj that ETS opens is not realistically generatable. The HDL Setup Tool exports device lists to Excel, but I found no documented import format.

**Open questions for the customer**

12. **HDL Buspro limits:** what are the official devices per bus / subnet, the maximum cable length per subnet (an old HDL slide says 1200 m), and the rule for power supply reserve? (See Q4.)
13. **Zigbee gateway capacity:** which gateway (model "E7 / MCIP-ZB.10"?) and what is its real limit? Typical figures are 32–128 devices, and they depend on how many routers there are. Should SnapFlow also show "routers present", e.g. a warning when there are many battery devices and no mains-powered router?
14. **Out of scope or not:** MCBs, RCDs and SPDs in the board? Recommendation: they can be placed and counted for rail space and BOM like any board product, but SnapFlow does not plan protection (no selectivity or cable sizing).
15. **Two relays as a blind:** Do their actuators use "N switch outputs or N/2 blind outputs" (MDT AKU: 24 switch or 12 blind outputs, mixed use possible)? If so, this "alternative" capacity must be in the model from the start.

---

## Q1. Existing tools

| Tool | What it models | Auto-select / auto-place | Bus / reserve checks | Output | Notes / user feedback |
|---|---|---|---|---|---|
| **Schneider eConfigure KNX** (ETS app, Lite/Expert) | Floors with a floor plan, devices and **loads** (lighting 10 A, switching 16 A, dimming areas 250/500/1000 W, 1–10 V, DALI, blinds 230 V AC / 24 V DC, floor heating, binary inputs) dropped on the plan; switchboards with actuators; channels with "connection codes" for compatibility | Three modes: **automatic** ("actuators are created automatically in order to connect all the loads … to its default actuator. You can make changes later"), **semi-automatic** (build actuators from selected loads), **manual** (drag loads to outputs). Each load type has a default actuator family. | Guide says: add repeaters "for any facility with more than 64 devices or a consumption above 640 mA". A BOM CSV of KNX devices (only KNX devices, so frames and PSUs must be added by hand). | Installation report (load list, "wire the actuators on right loads"), customer report to attach to the quotation, BOM CSV, ETS project | Closest analogue to SnapFlow. Its automatic mode **adds products**; SnapFlow's Q3 decision is the opposite. Both are defensible; see recommendation R6. |
| **Hager Ready** (app / Windows) | Boards (up to 10 per project), up to 3 cabinets with 12 rails; modular devices on rails; labels | Two automatic modes: "Automatisch" (enter the number of loads to protect → protection devices configured) and **"Automatisch nach Raumbuch"** (scope from DIN 18015 / RAL-RG 678) | Proposes only enclosures the devices fit into, and asks about space reserve and protection type (hagercad) | PDF documentation: circuit diagram, parts list, labels (label models with pictograms or ID code; print at 100%) | Review complaints: the wizard often picked wrong products (users added them by hand); no undo. |
| **hagercad** | Low-voltage boards, circuit diagrams, terminal plans, 25,000+ Hager products | Enclosure proposal limited to sizes that fit | Space reserve asked on layout | Labels, terminal plans, cost estimate | Power distribution, not bus planning. |
| **Schneider EcoSet Config** | Devices to mount, then a switchboard | Shows only compatible enclosure ranges; "spare space" setting; incompatible ones flagged with a warning icon | Spare space | — | Same pattern: devices → enclosure, reserve as a parameter. |
| **Siemens SIMARIS project / configuration** | Distribution systems (SIVACON, ALPHA boards up to 1250 A) | "Automatic selection of matching distribution systems and automatic placement of devices", front view with dimensions | (power engineering) | Tender texts (GAEB), IFC/BIM export | Power distribution; out of SnapFlow's scope, but shows the "front view with dimensions" output. |
| **ABB Building Planner / DOC / e-Design** | Building Planner: commercial KNX projects, IFC import, **room templates**; the BOM includes "the required number of module widths in the distribution board" | Room templates | — | BOM, module widths | DOC / e-Design: power distribution. |
| **KNX ETS 6** | Topology (area / line / device), buildings, functions, group addresses | — | Topology panel: **bus current per line = sum of devices (not power supplies or parked devices); 10 mA assumed when a product does not define it** | .knxproj; group address export/import CSV/XML | The reference for programming. Not a board planner. |
| **Loxone Config / planning** | Periphery tree (Miniserver → Link extensions (max 30) → Tree branches (50 devices, 500 m each) / Air); planning mode assigns products per room | Planning tool "adds the required extensions automatically", sizes power supplies, **calculates cabinet space**; room types drive auto-configuration | Branch / device limits in the docs; config filter "show unused devices" | BOM by project / category / room (CSV to the web shop); one click to a Config file | Strong supply/use model per interface (branch = our bus line). Its "unused devices" filter = our "free channels". |
| **KNXtool (BEMI)** | Building structure, devices, channels and push-button functions by drag and drop | No auto-selection described | — | **Actuator report (PDF: actuators with channel info for installers/programmers)**, purchase report, budget report, label printing, ETS / group address export | Confirms the deliverables installers want: channel-by-channel actuator list plus labels. |
| **uplan (Loxone, third party)** | Floor plan, extensions, Tree / Air | "Cabinet layout sized to the actual extensions" | — | Config export, cabinet drawing, wiring / topology, BOM, priced offer with labour | Proposal + board + export in one tool, as SnapFlow aims to be. |
| **HDL tools** (Buspro Setup Tool 2, HDL ON) | Device list per bus by subnet / device ID, per-device configuration, backup / restore | — | — | "Export current device list as excel file"; backup files | No planning / board tool found. |

**Copy:**
- A list of loads that are not connected yet (eConfigure).
- Auto / semi-auto / manual assignment with "you can make changes later" (eConfigure).
- Room templates (Hager Raumbuch, Loxone room types, ABB room templates).
- Per-line bus current with a default for unknown values (ETS).
- Offer only enclosures that fit, plus a reserve parameter (hagercad, EcoSet).
- An actuator / channel report for the electrician and labels (eConfigure, KNXtool, Hager).
- Totals in the board header (Loxone / ETS).

**Avoid:**
- Wizards that silently pick products the user then has to fix (the Hager Ready complaint). If SnapFlow ever suggests products, it should show them as a proposal to accept, not apply them.
- No undo (the Hager Ready complaint). Auto-connect must be undoable in one step.
- A BOM that lacks accessories (eConfigure's note). SnapFlow already has required add-ons.

Sources: [eConfigure KNX Expert user guide (PDF)](https://automatizace.hw.cz/files/story_automat/13017/201711userguideeconfigureknxexperten.pdf), [eConfigure KNX Lite guide](https://www.productinfo.schneider-electric.com/econfigure/econfigure-knx-lite-user-guide/English/BM_eConfigure_KNX_Lite_LSS900100_UG_DD00740618.pdf), [KNX news: eConfigure KNX 2.0](https://www.knx.org/knx-en/newsroom/news/news/20240221-Schneider-eConfigure-KNX-2.0/), [Hager Ready DE](https://hager.com/de/tools/hager-ready), [Hager Ready FAQ](https://hager.com/uk/digital-tools/faq-hager-ready), [Hager Ready App Store](https://apps.apple.com/gb/app/hager-ready/id1242959502), [hagercad brochure](https://assets1.sc.hager.com/exports/files/Hagercad_EN_WEB_sRGB.pdf), [Schneider EcoSet FAQ](https://www.se.com/au/en/faqs/FAQ000279597/), [SIMARIS brochure](https://assets.new.siemens.com/siemens/assets/api/uuid:c8a7c3bd-32cd-4178-88d9-14c481c12c8f/2020-simaris-brochure-en.pdf), [ABB Building Planner](https://new.abb.com/low-voltage/products/building-automation/service-and-tools/engineering-tools/abb-building-planner), [KNX support: topology panel](https://support.knx.org/hc/en-us/articles/360022048579-Topology-panel-Detailed), [Loxone Tree Extension](https://www.loxone.com/enen/kb/tree-extension/), [Loxone planning blog](https://www.loxone.com/enus/blog/project-planning-with-config/), [Loxone Config changelog](https://www.loxone.com/enen/support/changelog-config/), [Loxone Auto-Konfiguration](https://www.loxone.com/dede/kb/auto-konfiguration/), [BEMI KNXtool](https://www.bemi.fi/knx-management-tool/), [uplan](https://uplan.io/loxone-system-planning), [HDL Buspro Setup Tool 2 manual](https://www.hdlaonline.com/eshop/en/support/products/manuals/buspro/buspro-systeme-hbst2/um_hdl-buspro-setup-tool-2-(2018-01-29).aspx).

---

## Q2. Product data standards

### ETIM (group EG000032 "Installation bus systems", ETIM viewer v11) [verified]

| SnapFlow meaning | Dimming actuator EC001094 | Switch actuator EC001097 | Shutter actuator EC001330 |
|---|---|---|---|
| Outputs supplied | EF000319 Number of outputs | EF001739 Max. number of switching contacts | EF001740 Max. number of venetian-blind outputs |
| Inputs supplied | — | EF001992 Number of digital inputs | EF000318 Number of inputs |
| Limit per output | EF015953 Max. switching power LED (W); EF004479 Output power (W, range); EF001508 Type of load | EF003648 Max. switching current (A), EF000227 Rated current (A), EF001503 Max. switching power (W), EF015953 LED (W), EF003832 Suitable for C-load | EF001741 Switching current (resistive, A), EF001503 Max. switching power (W) |
| Voltage type (AC/DC motor) | — | — | EF000187 Voltage type (AC/DC/AC-DC) |
| Rail space | EF002950 Width in number of modular spacings | EF002950 | EF002950 |
| Mounting | EF000003 Mounting method (built-in, DIN-rail adaptor, flush, surface…) | EF000003 | EF000003 |
| System | EF001499 KNX, EF008855 KNX-RF, EF003811 Other bus systems (list includes Zigbee, DALI…; HDL Buspro not seen) | same | same |
| Bus current | **none** (only EF000346 Power consumption in W, EF001509 Max. control current mA for dimmers) | none | none |

The same width feature EF002950 is used for MCBs and other modular devices, and empty cabinets carry it too (EC000058).

**Assessment:** ETIM can fill outputs, width, mounting and some limits. It **cannot fill the two most important check values**: KNX bus current, and per-load-type limits beyond "LED". HDL Buspro is not a value in "Other bus systems", as far as I could see. The distributor's catalogue (HDL plus some KNX) will in practice come from datasheets and Excel.

**Recommendation:** let a column meaning carry an optional `etimFeature` code (e.g. EF000319). A later BMEcat/ETIM import can then fill the same field without new mapping questions. Do not design around ETIM.

### KNX product database [verified / secondary]

- .knxprod is a ZIP of XML files (Catalog, Hardware, Application program).
- The Hardware entry has a **`BusCurrent`** value. For power supplies it is the maximum current it can deliver; for other devices it is "the mean current drawn from the bus". It also carries flags such as `IsPowerSupply`, `IsCoupler`, `IsIPEnabled` and `HasIndividualAddress`.
- The application program defines communication objects with DPTs, and channels on newer applications.
- Rail width and the number of outputs are **not reliable fields**. They appear in catalog text or the product name, if at all.
- Reading bus current from .knxprod would be possible, but the files are big and often manufacturer-signed. Not worth it for phase 3; datasheet → Excel is enough.

### HDL product data [open]

- HDL publishes PDF datasheets per model, e.g. MSP2400.232 (24 V DC, 2400 mA, parallel modules allowed), MDT0601 (6 × 1 A, 6 A total, leading/trailing edge). Values like bus current appear in the datasheets (e.g. 35 mA actuator, 95 mA AC controller, 15 mA IR emitter; a 51-channel dry contact module up to 280 mA when all outputs are active).
- I found no machine-readable product database and no ETIM data.
- So the Excel-column approach of D187/D188 is right for this catalogue.

Sources: [ETIM EC001094](https://viewer.etim-international.com/class/EC001094), [ETIM EC001097](https://viewer.etim-international.com/class/EC001097), [ETIM EC001330](https://viewer.etim-international.com/class/EC001330), [ETIM EC001588 (EF002950)](https://viewer.etim-international.com/class/EC001588), [ETIM EC000058](https://viewer.etim-international.com/class/EC000058), [KNX support: hardware data sheet](https://support.knx.org/hc/en-us/articles/4557567856402-Hardware-data-sheet), [OpenKNX Kaenx-Creator issue #80](https://github.com/OpenKNX/Kaenx-Creator/issues/80), [knx-rs-prod](https://crates.io/crates/knx-rs-prod), [HDL MSP2400 datasheet](https://www.eldi.no/wp-content/uploads/2019/11/DS-HDL-MSP2400.232.pdf), [MDT0601 listing](https://www.autogarsas.lt/en/products/sviesos-reguliatorius-hdl-mdt0601-433-6x1a), [HDL 51CH dry contact datasheet](https://www.hdlautomation.com/vancheerfile/Files/2020/3/2020031610242904.pdf).

---

## Q3. Board physics and norms

- **Module width.** DIN 43880 ("Built-in equipment for electrical installations; overall dimensions and related mounting dimensions", 1988, still current) defines the division unit **TE = 17.5 mm**. Manufacturers also write "MW 18 mm" or "SU"; it is the same unit. The rail is the 35 mm top-hat rail (IEC 60715). Devices may be narrower than whole TE (e.g. some 1.5 TE accessories). → Store width as a **decimal TE**, not an integer. [verified for TE; the rest from common knowledge]
- **Enclosure sizes.** Enclosures are sold as rows × TE per row. In Germany a row is mostly 12 TE (larger boards 18 / 24 TE per row). DIN 18015-2: **at least 4 rows** in flats with several rooms, 3 in one-room flats; additional sub-boards at least 2 rows; about 20% space reserve (Hager tip; some sources say 30% as a rule of thumb). UK, Middle East and Pakistan practice follows BS 7671 / IEC and counts **"ways"** (SP&N / TP&N boards). The IET suggests about **20% spare ways**. Bangladesh's BNBC 2012 (which lists the Building Code of Pakistan as a reference) requires **one spare circuit per five circuits used**. I could not read the electrical chapter of the Building Code of Pakistan itself, and DEWA (Dubai) requires a load schedule per board but I found no spare-ways percentage. [secondary / open]
  → A board should carry `rows` and `TE per row` (from an enclosure product's fields, or entered on the board). Rail-space check: used TE vs. supplied TE, and per row when products are placed on rows. Show a reserve threshold.
- **IEC 61439-3** (DBO, distribution boards for ordinary persons, Ed. 2 2024): up to 250 A incoming, 125 A outgoing circuits. Temperature rise is verified by the board maker or assembler. Not something SnapFlow should calculate. [verified scope]
- **Dimmer heat.** Manufacturers derate:
  - ABB: reduce the load by the derating curve at high ambient temperature, when dimmers are mounted one below the other, or near other heat sources; −20% on gas-concrete, wood or plasterboard walls.
  - Lutron: no derating 0–30 °C; reductions per module at 30–40 °C, larger in boards with several rows.
  - Crestron: about 150 mm clearance above and below.

  → SnapFlow should **not** compute thermal derating. Offer an optional per-product note / field meaning "minimum spacing (TE)" or just show datasheet text. A global "planning margin %" on dimmer limits covers it pragmatically. [verified]
- **Power devices (MCB/RCD/SPD/contactors).** They take rail space and appear in the BOM, so it is useful to place them as board products with a width. Planning protection (selectivity, cable sizing, diversity) belongs to hagercad / SIMARIS / the electrician. → They can be placed, but SnapFlow does not plan them. An optional field meaning "rated current (A)" on an MCB could later link circuits to breakers; not phase 3.

Sources: [DIN 43880 (DIN Media)](https://dinmedia.de/en/standard/din-43880/1406097), [TE = 17.5 mm (proz)](https://vls.proz.com/kudoz/german-to-polish/computers-systems-networks/4355347-teilungseinheit.html), [Hager Tipp 21 DIN 18015](https://www.hager.de/files/download/0/29196671_1/0/20DE0117_TIP_21_DIN18015_STAND_210518_WEB.PDF), [Hager DIN 18015 page](https://hager.com/de/wissen/normen/din-18015), [elekrechner Verteilerplanung](https://www.elekrechner.com/ratgeber/praxis/verteilerplanung), [IET webinar Q&A (20% spare ways)](https://electrical.theiet.org/bs-7671/faqs/webinar-questions-and-answers/responsibilities-for-those-in-an-electrical-installation-design-role-webinar/), [BNBC 2012 electrical chapter](https://law.resource.org/pub/bd/bnbc.2012/gov.bd.bnbc.2012.08.01.pdf), [DEWA regulations 2017](https://www.dewa.gov.ae/-/media/DEWA_Regulations_for_Electrical_Installations_2017_Edition.ashx), [IEC 61439-3 scope (VDE preview)](https://www.vde-verlag.de/iec-normen/preview-pdf/info_iec61439-3{ed2.0}b.pdf), [ABB dimmer manual (derating)](https://library.e.abb.com/public/c5a25cb2b0e249a2ac6055f489dcb3bf/1473-1-8809_6252-101_THB_Dimmaktor-REG_ABB_EN_01.pdf), [Lutron AN #466](https://assets.lutron.com/a/documents/048466.pdf), [Crestron DIN-1DIMU4](https://www.crestron.com/specsheets/pdfhandler.ashx?action=generatedownload&modelnumbers=DIN-1DIMU4).

---

## Q4. KNX and HDL Buspro technical rules

### KNX TP [verified unless marked]

- **Line limits:**
  - Classic (TP1-64): 64 devices per line segment, each segment with its own power supply; up to 3 line repeaters → 4 segments / 255 devices.
  - Newer **TP1-256**: up to 256 devices per line without repeaters; mixing rule (4 × M(TP1-64) + N(TP1-256)) < 257.
  - Line repeaters are now "a legacy solution".
  - Up to 15 lines per area (line couplers) and 15 areas (area couplers). IP routers replace couplers in modern installations. Individual address = area.line.device.
- **Power supplies:** 160 / 320 / 640 mA are common; 1280 mA exists (KNX catalogue). Most lines remain at about 64 devices because of the power supply's mA ("the normal load calculations still need to take place"). Siemens: at most 2 power supplies per line [secondary].
- **Cable:** a line segment is at most **350 m from the power supply to the farthest device**, at most **700 m between two devices**, and at most **1000 m of cable per line** (all segments). SnapFlow does not know cable lengths. → Show as a note, not a check.
- **Bus current per device:**
  - Planning value 10 mA (ETS default); real values are typically 5–12 mA, up to about 25 mA [secondary].
  - Examples: ABB switch actuators < 12 mA.
  - Touch panels and IP devices often take an auxiliary 24/30 V supply. Their bus current is small, but they need an aux supply. → Possible later field meaning "aux supply current used / supplied".
- **Reserve:** 20% reserve (power supply loaded to at most 80%) is common practice; some forums say "plan a new line from 50 devices". Not a standard [secondary].

### HDL Buspro [mostly secondary / open]

- **Bus:** 24 V DC on CAT5E or HDL Buspro cable, daisy-chained.
- **Power supplies:** MSP750 (750 mA), MSP1200 (1200 mA), MSP2400 (2400 mA). Modules can be paralleled when one is not enough.
- **Voltage limits:** latching relays need > 15 V bus voltage, other devices > 8 V (old HDL presentation).
- **Typical current draw (HDL examples):** panels 20–30 mA, sensor 12 mA, dimmer 28 mA, relay 35 mA (switching), AC controller 95 mA, IR emitter 15 mA, large dry-contact modules up to 280 mA. **Values are clearly higher than KNX**, so the bus-current check matters more for HDL.
- **Devices / lengths:**
  - HDL-MBR06.431 6-port switch: "up to 63 devices … for each bus cable".
  - MBC06.431 fast connector: "up to 12 devices".
  - An old HDL presentation: "max. length of a subnet: 1200 m".
  - An old SmartBus manual: one IP module handles up to 253 devices per bus line.
  - **No current official per-subnet limit found.** → Ask the customer.
- **Addressing:** subnet ID 0–254 and device ID 0–254; device ID unique within a subnet. Factory defaults vary between documents.

### Dimmers [verified on examples]

- **Mode by load:** leading edge (R/L) for resistive and inductive loads (magnetic transformers); trailing edge (R/C) for capacitive loads and most dimmable LED drivers. Universal dimmers auto-detect the load. Limits differ a lot by mode: ABB DA/M.4.210.2.1 is LED 4 × 210 W trailing edge vs 4 × 80 W leading edge.
- **Minimum load:** 2 W (ABB), 3 VA (Homematic IP).
- **Module total < sum of channels** is common (HDL MDT0601: 6 × 1 A, 6 A total; some older HDL 6 × 1.5 A models: 9 A total).
- **Channel combining / single-channel boost:** ABB UD/S2.300.2 gives 2 × 300 W, or 500 W when only one channel is used; ABB UD/S lets outputs be paralleled to raise power.
- **Model in SnapFlow:**
  - per channel: a limit per load type (W or A), optional minimum load;
  - per module: a total;
  - leave single-channel boosts and parallel combining out (assume the conservative per-channel limit). This errs on the safe side.

### Blinds and multi-function actuators [verified on examples]

- A blind channel = 2 interlocked relays (up / down). It typically drives one AC motor per channel. Several motors on one channel need a separation relay (Siemens: "parallel operation of several drives with special separation relay"). → A blind need should use one channel per motor, and circuits (several needs on one channel) should **not** be allowed for blinds unless the product allows it.
- **DC motors** (24 V) need DC-rated actuators with pole reversal (Siemens: DC 24 V 6 A resistive / 4 A inductive). → "Motor type AC/DC" field on the blind output must match the need's load type.
- **Universal actuators:** MDT AKU-xx16.03 can be up to 24 switch outputs or up to 12 shutter outputs, **mixed use possible**. → Model as an output kind "relay" whose channels can be used either alone (switching) or as a pair (blind). The concept already says alternatives such as "8 relays or 4 blinds" are a setting of the output kind; keep that, and count a blind as using 2 relay channels.

Sources: [Mean Well KNX-20E-640 manual](https://www.meanwell.com/Upload/PDF/KNX-20E-E.PDF), [KNX TP1-256 news](https://knx.org/news/new-knx-tp1-256-topology-more-devices-and-fewer-line-repeaters), [Control4 KNX line coupler guide](https://control4.com/docs/product/knx-line-coupler-mdrc/dealer-user-guide/english/latest), [Ekinex 640 mA PSU](https://www.ekinex.com/en/153/knx-bus-power-supply-640-ma.html), [KNX 1280 mA PSU](https://knx.org/devices/power-supply-1280ma), [KNX user forum on reserve](https://knx-user-forum.de/forum/%C3%B6ffentlicher-bereich/knx-eib-forum/knx-einsteiger/1128629-anzahl-m%C3%B6glicher-busteilnehmer), [smart-home-feeling KNX planning](https://smart-home-feeling.de/ratgeber/planung/knx-elektroplanung), [ABB SA/S manual](https://library.e.abb.com/public/115f04c2ba104e819ca752ea5c11844f/SAS_4165S_PH_EN_V2-2_2CDC505056D0204.pdf), [pro-ait HDL system devices](https://www.pro-ait.com/system-devices.html), [HDL MBC06 datasheet](https://www.hdlautomation.com/vancheerfile/Files/2020/3/20200316105511182.pdf), [HDL-BUS Pro programming manual (Scribd)](https://www.scribd.com/document/415208327/HDL-BUS-Pro-Programming-Manual), [Buspro presentation (slideplayer)](https://slideplayer.com/slide/12023818/), [ABB DA/M dimmer](https://www.archiexpo.com/prod/abb-home-building-automation/product-53659-2317187.html), [Homematic IP DIN dimmer](https://homematic-ip.com/sites/default/files/downloads/hmip-drdi3-154434a0-datasheet.pdf), [HDL 6CH 1.5A dimmer](https://www.alltrade.co.uk/public/product/6ch-15a-mosfet-dimming-actuator.pdf), [ABB UD/S listings](https://ivoryegg.co.uk/shop/products/ud-s6-210-2-1-universal-dimming-actuator-6x210w), [Siemens JB 521C23](https://www.hqs.sbt.siemens.com/cps_product_data/data/en/bma/5WG1_521_4CB23_bma_usa_RS-AC.pdf), [MDT AKU](https://mdt.de/en/products/product-detail/actuators/universal-actuators/universal-actuators-aku.html).

---

## Q5. Zigbee

- **The limit is about direct children, not total network size.**
  - Nabu Casa: a coordinator without routers takes about 32 end devices directly; each router usually adds at least 5; with enough routers there is practically no limit.
  - Z-Stack firmware: direct-child limits from 5 to 100 depending on chip; "not the maximum network size".
- **Vendor numbers (examples):**
  - Tuya mini gateway: 32 low-power devices, or 35 mains-powered + 15 low-power.
  - Tuya multi-mode gateway / Sonoff Bridge Pro: 128 sub-devices.
  - Schneider Com'X 510: 20.
  - The concept's "HDL wireless gateway 48" and "E7 MCIP-ZB.10: 100" are **unconfirmed**. I found no datasheet for either. [open]
- **Planning rules that work in SnapFlow's model:**
  1. Gateway "max devices" as data (D191 stays).
  2. Optional per-product field meaning "**Zigbee router** (yes/no)": mains-powered switches, dimmers and plugs usually are; battery sensors are not.
  3. Warning when a gateway has many battery devices and no routers, e.g. "12 battery devices, 0 routers: add mains-powered devices or a repeater".
  4. No range calculation (stays as decided).
- **Several gateways per project** are realistic in big villas (separate floors, or per-gateway limits). Suggesting by floor or nearness (D191) is fine.

Sources: [Nabu Casa ZBT-1 article](https://support.nabucasa.com/hc/en-us/articles/30996960632989-How-many-Zigbee-devices-can-I-run-with-Home-Assistant-Connect-ZBT-1), [Z-Stack firmware README](https://github.com/Koenkk/Z-Stack-firmware/blob/5a4456a53d7647fdaf9aeb053c6bfb11e21b8fc5/coordinator/README.md), [Home Assistant ZHA](https://www.home-assistant.io/integrations/zigbee/), [Tuya mini gateway FAQ](https://support.tuya.com/en/help/_detail/K9i6ex49yir84), [Tuya low-power FAQ](https://support.tuya.com/en/help/_detail/K9i6huxv15jri), [Sonoff Bridge Pro 128](https://www.cnx-software.com/2022/05/03/sonoff-zigbee-bridge-pro-gateway-supports-up-to-128-sub-devices/), [Schneider Com'X 510](https://community.se.com/t5/Gateways-and-Energy-Servers/what-is-the-maximum-zigbee-connection-can-a-comx510-be-made-with/td-p/235181), [Tasmota discussion on router children](https://github.com/arendst/Tasmota/discussions/11536), [HDL Zigbee products (CSA)](https://csa-iot.org/csa_product/1ch-flush-mounted-dimming-actuator/).

---

## Q6. Needs / loads modelling and UX

- **Loads are separate from devices** in eConfigure (non-communicating loads with a type and a power class, each with compatible actuator families). This is the same as SnapFlow's needs, which are not products (D186). eConfigure puts loads on the floor plan as icons. SnapFlow's optional "load symbols" matches this; a list per zone is faster to enter.
- **Templates:**
  - Hager: room book by DIN 18015 / RAL-RG 678 equipment levels (the German "Ausstattungswert" 1–3 stars defines sockets, lights etc. per room type).
  - Loxone: room types (bedroom / living / passage) plus m² for its lighting auto-planner.
  - ABB: room templates.

  → Room templates with a **name + list of needs**, possibly per equipment level ("Bedroom – basic / comfort"). Applying a template adds lines; it does not link the zone to the template (no hidden sync).
- **Coverage display patterns:**
  - eConfigure's "loads not yet connected, by floor" list.
  - Loxone's "show unused devices" filter.
  - ETS's per-line current in the topology panel.

  → Three views:
  1. Zone status on the floor plan: covered / "2 of 4" / missing, colour plus text, not colour alone (as in the concept).
  2. A project-wide **"Unconnected needs" list** grouped by floor/zone, with a drag target or "connect to…".
  3. Board header totals (bus current, devices, TE) with reserve thresholds.
- **Auto-assign with manual override, good practice from eConfigure / Hager:**
  - three levels: auto for everything, auto for a selection, manual drag;
  - auto never moves manual connections ("pinned");
  - a preview / summary before applying ("Auto-connect will connect 14 needs; 3 cannot be connected: no free blind output");
  - one-step undo;
  - deterministic order (same input gives the same result), e.g. by floor → zone → need order → board order → channel number, preferring the same board and filling one module before starting the next.

  This keeps runs on one actuator, which electricians like (one load per channel in sequence matches labelling).
- **Circuit (several needs on one channel):** allowed for lights and sockets if the sum is within the limit (common practice). Not for blinds (one motor per channel) and not for inputs (one pushbutton per input, unless the product says otherwise).

Sources: [eConfigure KNX Expert guide](https://automatizace.hw.cz/files/story_automat/13017/201711userguideeconfigureknxexperten.pdf), [Hager Ready DE](https://hager.com/de/tools/hager-ready), [Loxone light planning](https://www.loxone.com/dede/blog/lichtplanung/), [Loxone Auto-Konfiguration](https://www.loxone.com/dede/kb/auto-konfiguration/), [ABB Building Planner](https://new.abb.com/low-voltage/products/building-automation/service-and-tools/engineering-tools/abb-building-planner), [ELEKTRO+ planning](https://www.elektro-plus.com/elektroplanung/tipps-zur-elektroinstallation/zaehlerschrank-und-stromkreisverteiler-richtig-planen).

---

## Q7. Programming export (later) – what to store now

- **ETS group addresses:**
  - Import via the Group Addresses panel; the format is detected automatically.
  - **CSV:** 1/1 or 3/3 columns. Typical columns: Group name, Address (main/middle/sub rows as `0/-/-`, `0/0/-`, `0/0/1`), Central, Unfiltered, Description, DatapointType (`DPST-1-1`), Security. Tab separated, often ISO-8859-1.
  - **XML:** namespace `http://knx.org/xml/ga-export/01`, `GroupRange(Name, RangeStart, RangeEnd)` › `GroupAddress(Name, Address, DPTs, Description)`.
  - Import adds and renames; it does not delete.

  → SnapFlow can generate group addresses per zone × function (e.g. main = floor, middle = room, sub = function such as switch / dim / value / status) from the needs connected to channels.
- **ETS project / topology:**
  - ETS6 exports only .knxproj; files are version-bound.
  - Creating a .knxproj that ETS accepts from outside is not supported (third-party writers are experimental; signing problems with dongle licences).
  - The "Project Data Exchange" ETS app imports topology / group addresses / building structure from other tools (paid, by IT GmbH).
  - Reading a .knxproj is easy (xknxproject: devices, individual addresses, channels, group addresses with DPTs, rooms) → a future "import existing KNX project" for existing devices is realistic.
- **HDL Buspro Setup Tool 2:** export of the device list to Excel and backup files. No documented import for planned addresses found. [open] The likely output is a commissioning sheet (subnet / device ID, model, room, channel remarks) that the installer types in or the HDL distributor imports with their own tools. Ask the customer.
- **Zigbee gateway apps (HDL ON / Tuya):** devices are paired on site. Import of planned names / rooms is unknown [open]; the realistic output is a checklist per gateway (device, room, name).

**Data to store from phase 3 on (cheap now, expensive later):**

- per placement: system/bus line, and gateway for Zigbee (planned);
- per channel: the connected needs (function type, zone, label);
- per need: function type, zone, a stable order / label.

Per-unit fields that can stay empty until site / programming (category `instanceAttributes` already exist):

- KNX individual address;
- HDL subnet ID / device ID;
- Zigbee IEEE address / serial number.

Address *assignment* (auto-numbering) is phase 4. Keep the bus line as an entity (name, system, power-supply placements), because both KNX lines (area.line) and HDL subnets map onto it.

Sources: [KNX ETS6 GA import (devicebase)](https://devicebase.net/en/knx-association-ets6-professional/questions/how-to-import-or-export-ets-group-addresses/5kl), [knx-ga-exporter](https://github.com/waldbaer/knx-ga-exporter), [ABB ETS GA training](https://library.e.abb.com/public/02d03f979e59478c845af18759dd2030/OnlineTraining-KNX-ETS-Groupaddresses-April-2020_PR_EN_V1-0_9AKK107680A5823.pdf), [Loxforum GA XML DTD](https://www.loxforum.com/forum/eib-knx-schnittstelle/191358-xml-export-der-gruppenadressen-dtd-datei), [KNX support project export](https://support.knx.org/hc/en-us/articles/360020990259-Project-export), [MyKNX project export tools](https://my.knx.org/en/shop/ets-apps/project-export-tools), [xknx-editor issue #63](https://github.com/XKNX/xknx-editor/issues/63), [xknxproject](https://pypi.org/project/xknxproject/), [HDL Buspro Setup Tool 2 manual](https://pdfcoffee.com/umhdl-buspro-setup-tool-2-2017-08-04pdf-pdf-free.html).

---

## Recommendations for the phase 3 spec

| # | Recommendation | Mark |
|---|---|---|
| R1 | Zone needs (function type, qty, per-unit power, load type, note) and room templates; loads are not products and not in the BOM (D186) | **keep** |
| R2 | Capabilities from Excel columns, with meanings defined once per column for the whole catalogue (D187/D188) | **keep** |
| R3 | Empty value: still "does not count" for outputs/limits, but for **bus current on a bus product** show "unknown for N devices" and optionally use a per-system default (KNX 10 mA as ETS does) | **change** |
| R4 | "Max devices per line" comes from data (power supply / line product field, or a per-system setting), not a constant 64; show KNX TP1-256 / HDL 63 as examples only | **change** |
| R5 | Reserve setting (default 20%) for bus current, devices, rail space and gateway places: amber above (100 − reserve)%, red when exceeded | **add** |
| R6 | Auto-connect: keep "never adds products" (Q3); add preview summary, one-step undo, pinned manual connections, deterministic fill order (same board, fill module before next). Later option: "suggest products for missing channels" as an explicit proposal (eConfigure does this automatically) | **keep + add** |
| R7 | Dimmer limits: per load type per channel + module total (as in the concept); add optional "minimum load per channel"; no derating or boost modelling, but an optional planning margin % on output limits | **keep + add** |
| R8 | Blind needs: one need per motor, no circuits on blind outputs; motor type AC/DC must match; relay pairs as blind ("N relays or N/2 blinds", mixed use) modelled as an output-kind alternative from the start | **add** (confirm with customer Q5) |
| R9 | Circuits (several needs on one channel) only for function types that allow it (lights, sockets); a flag on the function type or output kind | **add** |
| R10 | Rail space: width in decimal TE (17.5 mm); the board has rows × TE per row (from an enclosure product's "TE supplied" / "rows" fields or entered on the board); check total and per row | **add** |
| R11 | MCB/RCD/SPD may be placed as board products (width, BOM); no protection planning, selectivity or cable sizing | **out of scope** (planning) / **keep** (placement) |
| R12 | Thermal calculation, cable length / voltage drop, KNX segment lengths | **out of scope** (show norms as hint text) |
| R13 | Optional `etimFeature` code on a column meaning for later BMEcat/ETIM imports; Excel stays the source | **add** (low priority) |
| R14 | Bus line entity per system (name, system, power supplies, members); default one per system and project, can be split; KNX area.line / HDL subnet stored on it for later | **keep + add** |
| R15 | Zigbee: gateway places (D191); add optional field meaning "Zigbee router" and a warning "many end devices, no routers"; no range calculation | **keep + add** |
| R16 | Outputs for the installer: board report per board (rails, modules, channel → zone / need label, totals) and channel labels; these are what eConfigure / KNXtool / Hager users value | **add** (phase 3 or with documents) |
| R17 | Project-wide "Unconnected needs" list grouped by floor/zone, plus zone status on the floor plan with text, not colour only | **add** |
| R18 | Store programming-relevant data now (bus line / gateway per placement, channel ↔ needs, per-unit address fields as category `instanceAttributes`); address assignment and file export later; first export target: ETS group address CSV/XML (simple); HDL and Zigbee as commissioning sheets until import formats are known | **keep** (D192) + **add** detail |
| R19 | Reading an existing ETS .knxproj to create existing devices (xknxproject-style parsing) | **out of scope** for phase 3; candidate for later |
| R20 | Auxiliary 24/30 V supply budget for panels / IP devices (field meanings "aux current used / supplied") | **out of scope** for phase 3; the generic "used ≤ supplied" mechanism already allows adding it as data |

### Open questions to send to the customer

1. HDL Buspro: official max devices per bus / subnet, max cable length, power supply reserve rule; how they size MSP750 vs. MSP2400 today.
2. Zigbee gateway model(s) and their device limit; do they place repeaters?
3. Do their actuators allow relay pairs as blinds, and is mixed use per module common?
4. Which reserve do they want by default (20%?) for bus current and rail space?
5. Are MCBs / RCDs part of what they sell and draw in the board, or only smart-home modules?
6. Enclosure: do they sell enclosures (rows × TE), and is the market's norm "ways" or TE (Pakistan, Middle East)?
7. What do installers need printed: board layout, channel list, labels?
