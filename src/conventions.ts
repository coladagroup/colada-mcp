export const CONVENTIONS_URI = 'colada://conventions'

export const INSTRUCTIONS = `Colada backoffice API through get_api_doc, api_get and api_write. You act with the user's own roles in one workspace per call.
- Find the route in get_api_doc first. Do not guess paths.
- Fewer fields on lists: projection in the path, /api/events:(title,start).
- Filter: query q, for example (title=*expo*)&(archived=!true). A q the service cannot parse is dropped silently and the call returns everything: check the total and a few items.
- To change a record: read it, take the revision from X-ETag, change only what is needed, send the write with If-Match: <revision>. 409 means someone changed it: read again.
- Some PATCH and PUT routes replace a whole map or structure (guest attributes on PATCH /guests/{id}, email template l10n, form structure). Send the complete value.
- Before a series of writes, show the user the planned calls and wait for a yes. Try a bulk change on one record first.
- Details and service rules: read the resource ${CONVENTIONS_URI}.`

export const CONVENTIONS = `# Colada backoffice API conventions

Rules that hold for the backoffice services behind /_gw/<service>/api. The api-doc of each service (get_api_doc) is the source for routes and bodies; this text explains what the api-docs do not.

## Reading lists

- Paging uses the Range header described in api_get. At most 1000 items per call. Without a valid Range many services return 0-40 (41 items).
- Use the resource's own unit (events, emailtemplates, ...). The response "Content-Range: <unit> <start>-<end>/<total>" names it. <end> there is the requested end, not the last returned item: count the body on the last page.
- 200 and 206 both mean success. Use <total>, not the status, to decide if there are more pages.
- The body of a list is a plain JSON array. No match gives [] with total 0, not 404.
- You only get records you may see. A missing record can mean "no access".

## Projection

- /api/events:(title,start,end) returns only these fields plus id, revision, audit fields and required fields.
- Field names are letters, digits and _ only. No nested paths. Unknown fields are ignored.
- Only on list routes that declare it (see the api-doc). A single record (GET /api/events/{id}) is always complete.

## Filter q

- Pass as query q. Sort with query sort=field:asc|desc, several separated by commas.
- field=value is exact and case-sensitive. & is AND, | is OR, ( ) groups.
- field=!value: not equal. field=a,b: a or b. field=a;b: a and b.
- * only at the start and/or end: foo*, *foo, *foo* (case-insensitive). Not on numbers or booleans.
- field=null / field=!null: missing or null / set. field?=value also matches records without the field.
- Ranges: [a,b] inclusive, (a,b) exclusive, open ends [a,] and [,b]. Values: yyyy-MM-dd, yyyy-MM-ddTHH:mm[:ss][Z], HH:mm, or numbers.
- Dotted names (address.city) work in q.
- Inside a value, escape & | ( ) , ; % as %26 %7C %28 %29 %2C %3B %25.
- Errors in q are not reported. An unparsable condition is dropped, and the call may return everything. Always compare the total with what you expect.

## Writing

- Revision: every read of one record and every write return "X-ETag: <revision>", a plain number (the services send ETag, the gateway renames it to X-ETag). Send it back as "If-Match: <revision>".
- Without If-Match most update routes answer 400; with an old revision 409. Then read again, merge your change, retry.
- Create (POST) usually answers 201 with the record and X-ETag. Updates answer 204 with X-ETag, or 200/201 with the record. Check the api-doc of the route.
- PATCH changes only the top-level fields you send. A nested object or list is replaced as a whole: send its complete value.
- "$unset" as a value removes a field. null is ignored on most PATCH routes. Required fields cannot be removed.
- Custom fields are named x_* . On events they go in the body map ext ({"ext": {"x_code": "A1"}}). On guests they are normal keys of attributes.
- Errors: typed errors come as JSON {code, message}. Validation errors are often plain text. Some errors have no body.

## Service rules

Events (s-events)
- POST /api/events needs title, start, end (local date-time without offset, 2026-10-09T10:00:00), timeZone (Europe/Zurich), lang, guestSchema and applications.
- In a workspace with org structure, a new event needs departments, or users cannot see it: PUT s-orgstructure /api/orgstructure/events/{event_id}/departments with a JSON array of department ids. Your own departments: GET /api/orgstructure/users/me/departments.

Email templates (s-email-templates)
- One template: GET or PATCH /api/events/{event_id}/emailtemplates/{template_id}. PATCH needs If-Match and displayName.
- l10n is replaced as a whole: send every language, not only the changed one.
- Each language has subject and body. A designer body has json (the editor design, a JSON string) and html (the rendered mail); change both together or the editor and the mail differ. A simple body has only content.
- PATCH /api/events/{event_id}/emailtemplates without an id is a bulk delete. Do not use it for updates.
- Paging works on GET .../emailtemplates/all (unit emailtemplates). GET .../emailtemplates ignores Range.

Registration forms (s-events-forms)
- Base: /api/events/{event_id}/formtemplates/registration. PUT .../structure and PUT .../settings need If-Match.
- structure holds pages; the elements of a page are a map per language. A new field must go into the list of every language of the page. Send the whole structure back.
- PUT .../published publishes.

Guests (s-events-guests, personal data)
- PATCH /api/events/{e}/guests/{g} replaces all attributes: missing ones are removed.
- PATCH /api/events/{e}/guests/{g}/attributes changes only the attributes you send.

## Errors from this MCP

- A blocked call (personal data, delete route, secret route, header) is refused before anything is sent. Tell the user; do not try other paths to the same data.
- writeNoResponse: the write may have been applied. Read before you retry.
- 401 on a write is not resent. Call api_write again; the user approves again.
- Responses over 500 KB are refused. Use Range, q or a projection.
`
