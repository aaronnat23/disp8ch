# Feishu Permissions

Manage access permissions on Feishu/Lark documents and drive files.

- Auth: use tenant access token (same pattern as feishu-doc).
- Get permissions: `GET /drive/v1/permissions/{token}/members?type={docx|file|folder}` — lists current members and their roles.
- Add a member: `POST /drive/v1/permissions/{token}/members` with `{"member_type": "userid", "member_id": "...", "perm": "view|edit|full_access", "type": "docx"}`.
- Update a member's role: `PUT /drive/v1/permissions/{token}/members/{member_id}` with updated perm field.
- Remove a member: `DELETE /drive/v1/permissions/{token}/members/{member_id}?type=docx&member_type=userid`.
- Transfer ownership: `POST /drive/v1/permissions/{token}/transfer_owner` with `{"member_type": "userid", "member_id": "..."}`.
- Get public link settings: `GET /drive/v1/permissions/{token}/public?type=docx` — shows link share mode.
- Update sharing settings: `PATCH /drive/v1/permissions/{token}/public` with `{"link_share_entity": "tenant_readable|anyone_readable|closed"}`.
- Always confirm the resource type (`docx`, `file`, `folder`, `wiki`) before making permission changes.
