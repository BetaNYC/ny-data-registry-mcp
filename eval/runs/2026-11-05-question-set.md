# Question-set results

Run: 2026-11-05T18:45:40.463Z · registry 2026-11-05 · index last harvest 2026-11-05T18:44:22.100Z

**Score: 27/27 (100%)** · target >= 90% · invariant violations: 0 · PASS

| id | question | result | detail |
|---|---|---|---|
| Q01 | Does Erie County publish parcel data? | PASS | list_sources_for_place: answer = "no-portal-exists" (want "no-portal-exists"); search_datasets: found in top 3 |
| Q02 | What is the Socrata domain for state health data? | PASS | how_to_query: use.domain = "health.data.ny.gov" (want "health.data.ny.gov") |
| Q03 | Which NY portals have anything on lead pipes? | PASS | search_datasets: found in top 3 |
| Q04 | What joins to 311 by BBL? | PASS | find_joinable: keys.0.datasets_sharing_key = 426 (want >= 100) |
| Q05 | rodent | PASS | search_datasets: found in top 3 |
| Q06 | parcels | PASS | search_datasets: found in top 3 |
| Q07 | Does Buffalo have an open data portal? | PASS | list_sources_for_place: answer = "portal-exists" (want "portal-exists") |
| Q08 | Where is New York City's open data portal? | PASS | find_sources: found in top 3 |
| Q09 | Where is New York State's GIS data? | PASS | find_sources: found in top 3 |
| Q10 | Is the City of Albany's open data portal up? | PASS | list_sources_for_place: answer = "portal-dead" (want "portal-dead") |
| Q11 | How do I query NYC Council legislation? | PASS | how_to_query: use.mcp = "nyc-council-mcp" (want "nyc-council-mcp") |
| Q12 | What is Nassau County's Socrata domain? | PASS | how_to_query: use.domain = "opennassau.nassaucountyny.gov" (want "opennassau.nassaucountyny.gov") |
| Q13 | Suffolk County parcel data? | PASS | search_datasets: found in top 3 |
| Q14 | What does Monroe County publish? | PASS | find_sources: found in top 3 |
| Q15 | Does Syracuse have open data? | PASS | list_sources_for_place: answer = "portal-exists" (want "portal-exists") |
| Q16 | NYC street trees | PASS | search_datasets: found in top 3 |
| Q17 | COVID hospitalizations in New York State | PASS | search_datasets: found in top 3 |
| Q18 | NY Lottery winning numbers | PASS | search_datasets: found in top 3 |
| Q19 | Westchester municipal boundaries | PASS | search_datasets: found in top 3 |
| Q20 | DEC environmental remediation sites | PASS | search_datasets: found in top 3 |
| Q21 | Who owns this building? (landlord data) | PASS | find_sources: found in top 3 |
| Q22 | Statewide climate and weather station data | PASS | find_sources: found in top 3 |
| Q23 | Does Tompkins County have a portal? | PASS | list_sources_for_place: answer = "portal-exists" (want "portal-exists") |
| Q24 | Buffalo 311 requests | PASS | search_datasets: found in top 3 |
| Q25 | Is the Long Island Index still live? | PASS | find_sources: not returned |
| Q26 | NYC 311 data as CSV | PASS | search_datasets: found in top 3 |
| Q27 | How do I get NYC 311 service-request status? | PASS | how_to_query: use.mcp = "nyc-311-mcp" (want "nyc-311-mcp") |

## Invariant violations
None.
