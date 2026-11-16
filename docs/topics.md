# Topics: one shared list for New York's portals

Issue [#18](https://github.com/BetaNYC/ny-data-registry-mcp/issues/18), part of epic
[#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7). Shipped in 0.4.0.

## Why

New York's portals do not share a topic list. On the 2026-11-05 index, 35 portals use 154
category labels, about 7,900 tags and about 770 department names, and most labels appear on one
portal only. The same kind of data goes by different names: "Housing & Development" on NYC Open
Data, "Real Property" on Albany County's portal, "Cadastral parcels" on a GIS portal. A topic
list lets one question reach all of them.

No outside list fits as it is:

- **DCAT-US** (`theme`) asks for a category but names no list.
- **Socrata** lets each portal pick its own categories.
- **ISO 19115** has 19 fixed topic codes. Many New York GIS portals use them, but there is no code
  for education, housing, elections, public safety or government operations.

So the list is built from the labels New York's portals already use.

## The 24 topics

Counts are live datasets and portals on the 2026-11-05 index. A dataset can have several
topics, so the counts add up to more than the number of datasets. ISO 19115 shows the closest
ISO topic code, for anyone publishing DCAT-US `theme` values; "—" means ISO has none.

| # | id | Topic | Datasets | Portals | ISO 19115 |
|---|---|---|---|---|---|
| 1 | `environment` | Environment and conservation | 1,976 | 28 | environment, biota |
| 2 | `government` | Government operations and transparency | 1,911 | 21 | — |
| 3 | `transportation` | Transportation | 1,459 | 29 | transportation |
| 4 | `landuse` | Land use, zoning and planning | 1,370 | 31 | planningCadastre |
| 5 | `water` | Water, coasts and waterways | 1,144 | 29 | inlandWaters, oceans |
| 6 | `education` | Education | 1,133 | 27 | — |
| 7 | `boundaries` | Boundaries and administrative areas | 1,108 | 33 | boundaries |
| 8 | `finance` | Budget, finance and taxes | 1,097 | 23 | economy |
| 9 | `recreation` | Parks, recreation and culture | 1,082 | 33 | — |
| 10 | `health` | Health | 1,017 | 21 | health |
| 11 | `economy` | Economy, business and labor | 990 | 21 | economy |
| 12 | `utilities` | Energy, utilities and telecommunications | 697 | 24 | utilitiesCommunication |
| 13 | `safety` | Public safety and criminal justice | 642 | 31 | — |
| 14 | `buildings` | Buildings, construction and permits | 629 | 24 | structure |
| 15 | `basemaps` | Base maps, imagery and earth science | 602 | 33 | imageryBaseMapsEarthCover, elevation, geoscientificInformation, location |
| 16 | `demographics` | Population and demographics | 567 | 23 | society |
| 17 | `social` | Social and human services | 489 | 19 | — |
| 18 | `housing` | Housing and homelessness | 458 | 15 | — |
| 19 | `property` | Property, parcels and assessment | 457 | 27 | planningCadastre |
| 20 | `quality_of_life` | 311, service requests and quality of life | 340 | 8 | — |
| 21 | `climate` | Climate, hazards and emergency management | 321 | 21 | climatologyMeteorologyAtmosphere |
| 22 | `elections` | Elections and civic participation | 289 | 25 | — |
| 23 | `agriculture` | Agriculture and food | 253 | 23 | farming |
| 24 | `sanitation` | Sanitation and waste | 238 | 15 | utilitiesCommunication |

**Coverage:** 8,910 of 9,569 live datasets (93.1%) get at least one topic. Most get one to
three. The rest carry no category, tag or department that fits the list. Text search still finds
them.

Four pairs are close and are kept apart on purpose, because people search for each side on its
own: housing and property, 311 and government operations, climate and water, sanitation and
utilities.

## How a dataset gets its topics

1. **Collect its labels.** Every category, tag and department on the dataset, as the portal wrote
   it.
2. **Clean each label.** Keep the last part of an ArcGIS category path
   (`/Categories/People/Health` becomes `health`). Lowercase. Turn `&` into "and", and `_` and `-`
   into spaces. Drop other punctuation. Make the last word singular, except for words like
   "census" and "gis". Split a few run-together words ("publicsafety") and merge a few spelling
   variants (covid, coronavirus and covid-19; bike and bicycle). Department names in the form
   "Health, Department of" become "department of health", and a trailing "(ACRONYM)" is set aside.
3. **Hand-assigned words first.** If the cleaned label is in `data/topic-hand-assigned.json`, its
   topics come from there and nothing else.
4. **Then the match rules.** Each topic in `data/topics.json` has a list of word rules. A label
   gets every topic whose rules it matches, so one label can give several topics ("school
   district" gives Education and Boundaries).
5. **Agency acronyms.** A tag with no topic that is an agency's acronym takes that agency's
   topics. The acronyms come from the index's own department names, such as
   "Department of Buildings (DOB)", never from a guess. `acs`, `gis` and `ems` never do this.
6. **The dataset's topics** are all the topics its labels give.

Labels with no topic are marked in the crosswalk when they name a place, a year, a file format,
or a publishing office (`non_topical`). Those never give a topic.

### Words decided by hand

Some words are too broad, or mean different things on different portals. They are in
`data/topic-hand-assigned.json`, each with a reason. Examples:

- **infrastructure** → Energy, utilities and telecommunications. Roads and bridges get
  Transportation from their own words.
- **safety** → Public safety. Inside a longer label it no longer counts by itself: "traffic
  safety" is Transportation, and Health Data NY's "Quality, Safety & Cost" is Health.
- **development** → Land use. It can mean economic, land or youth development.
- **ACS** as a tag → Population and demographics (the American Community Survey). NYC's
  Administration for Children's Services is a department name and gets Social services.
- **lot** → no topic. It is a tax lot in one dataset and a parking lot in the next.

To change a word, edit that file: give the cleaned label, its topics (or `[]` for none), and a
`why`. A `label_type` (category, tag or department) limits an entry to one kind of label. The
tests refuse an entry with an unknown topic or no reason.

## The crosswalk file

`topic-crosswalk.csv` lists every label on every portal and what it gives. It is published
beside the index in every nightly release, so it always matches the index it came with:
`https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/topic-crosswalk.csv`.

Columns: `portal_id`, `label_type` (category, tag, department), `original_label`,
`normalized_label`, `topic_ids`, `topic_names`, `assigned_by` (rule, hand, acronym, none),
`non_topical` (place, year, format or housekeeping, publisher), `dataset_count`.

On the 2026-11-05 index (the one this feature was reviewed against), 14,082 portal labels:
6,982 matched a rule, 77 were hand-assigned, 69 took an agency's topics, and 6,954 got no topic
(695 of those named a place, a year, a format or a publisher).

## Rebuild it

The harvest rebuilds every dataset's topics at the end of each run, including portals it did not
read that night. To rebuild them on your own copy of the index and write the crosswalk:

```sh
node dist/cli.js topics --crosswalk-out topic-crosswalk.csv
```

This reads only the index on your computer. It makes no network calls.

## Where the code is

- `data/topics.json`: the 24 topics, their match rules, label cleanup, and the non-topical
  patterns.
- `data/topic-hand-assigned.json`: words decided by hand.
- `src/topics.ts`: cleanup, matching, the crosswalk, and the `topics` and `dataset_topics`
  tables in the index.
- `test/topics.test.mjs`: the tests.

The topic tables were added to the index without changing its schema version, so older servers
still read new indexes. A server reading an index built before 0.4.0 says how to update it when a
topic is asked for.

## Limits

- **Only harvested portals.** Only portals with a harvested catalog are counted.
- **NYC weighs heavily.** NYC Open Data has about a third of the datasets.
- **Rules, not review.** Topics come from word rules. Spot checks fixed the false matches found,
  but not every label was read. Long department strings (credit lines, citations) can pick up a
  topic by accident.
- **Many tags get no topic.** On the 2026-11-05 index, 6,686 of 12,875 portal tags (52%) get
  none; 4,072 of those are on a single dataset. Topic counts are a floor.

## Sources

- DCAT-US v1.1 and v3.0: <https://resources.data.gov/resources/dcat-us/> and
  <https://resources.data.gov/standards/catalog/dcat-us-3/dataset/>.
- ISO 19115 topic categories, as published by the EU INSPIRE registry:
  <https://inspire.ec.europa.eu/metadata-codelist/TopicCategory/TopicCategory.en.json>.
- Socrata Discovery API, on per-domain categories: <https://dev.socrata.com/docs/other/discovery>.
