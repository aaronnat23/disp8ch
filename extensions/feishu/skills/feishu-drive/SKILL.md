# Feishu Drive

Manage files and folders in Feishu/Lark Drive (cloud storage).

- Auth: use tenant access token from `POST /auth/v3/tenant_access_token/internal` (same as feishu-doc). Cache it in memory.
- List folder contents: `GET /drive/v1/files?folder_token={token}` — returns files and subfolders.
- Get file metadata: `GET /drive/v1/files/{file_token}` — returns name, type, size, owner, modified time.
- Upload a file: `POST /drive/v1/files/upload_all` with multipart form data (file_name, parent_type, parent_node, size, file).
- Download a file: `GET /drive/v1/files/{file_token}/download` — returns binary; save with `write_file`.
- Create a folder: `POST /drive/v1/files/create_folder` with `{"name": "...", "folder_token": "..."}`.
- Move a file: `POST /drive/v1/files/move` with `{"token": "...", "type": "file", "to_parent_token": "..."}`.
- Copy a file: `POST /drive/v1/files/copy` with `{"name": "...", "folder_token": "..."}`.
- Always URL-encode file names when used in query params.
