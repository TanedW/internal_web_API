```mermaid
---
config:
  layout: dagre
---
erDiagram
    %% Admin System Tables
    admin_system {
        int admin_id PK "Primary Key"
        string email "Unique Email"
        string first_name
        string last_name
        string profile_url
        string access_token
        timestamp join_at
    }

    admin_system_logs {
        int id PK
        int admin_id FK "References admin_system"
        string action_type "Login, Add, Update, Delete"
        string status "Success, Failed"
        string ip_address
        string user_agent
        string email "Snapshot of email"
        string first_name "Snapshot of name"
        string last_name
        jsonb details "Extra info (target_id, etc.)"
        timestamp created_at
    }

    %% Case Management Tables
    issue_cases {
        uuid issue_cases_id PK "Primary Key (UUID)"
        string case_code "e.g., CASE-001"
        string cover_image_url
    }

    case_media {
        int id PK
        uuid case_id FK "References issue_cases"
        string url
        string media_type "image, video"
        timestamp created_at
    }

    %% Relationships
    admin_system ||--o{ admin_system_logs : "performs / logs"
    issue_cases ||--o{ case_media : "contains"

    ```