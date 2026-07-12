# MCP Common Server

Zero-dependency Node.js MCP server with **284 tools** across 10 categories.

| # | Category | Tools |
|---|---|---|
| 1 | Read & File System | 38 |
| 2 | Write & Edit | 8 |
| 3 | Git | 42 |
| 4 | Code Analysis & Audit | 51 |
| 5 | Security Scanning | 44 |
| 6 | Browser Automation | 36 |
| 7 | Network & Messaging | 21 |
| 8 | Data & Format Utilities | 27 |
| 9 | Execution & Process | 7 |
| 10 | Email & Database | 9 |
| | **Total** | **284** |

## Read & File System (38)

`read_directory`, `read_file`, `read_files`, `read_allfiles`, `file_info`, `search_files`, `search_lines`, `search_in_document`, `file_checksum`, `checksum_verify`, `hash_string`, `regex_test`, `env_info`, `system_resources`, `which_command`, `compare_directories`, `file_diff_dir`, `count_lines`, `file_tree`, `hash_directory`, `base64_encode`, `text_transform`, `file_stats`, `dir_size_stats`, `disk_usage_summary`, `dir_diff_summary`, `image_ops`, `pdf_rich_extract`, `pdf_to_md`, `docx_to_md`, `docx_to_pdf`, `dotenv_client`, `toml_client`, `yaml_client`, `ini_client`, `xml_client`, `markdown_client`, `csv_client`, `jsonl_client`

## Write & Edit (8)

`write_file`, `write_files`, `create_file`, `create_files`, `replace_in_file`, `truncate_file`, `append_file`, `base64_decode`

## Git (42)

`git_write_ops`, `find_stale_branches`, `check_branch_protection_hints`, `git_hooks_audit`, `git_status`, `git_log`, `git_blame`, `git_diff`, `git_stash_list`, `git_branch_list`, `git_worktree_list`, `git_worktree_prune_candidates`, `git_commit_message_lint`, `check_gitignore_coverage`, `git_diff_summary`, `git_show`, `git_tag_list`, `git_reflog`, `git_dangling_commits`, `git_object_count`, `git_untracked_size`, `git_cherry`, `git_contributors_summary`, `find_recent_force_pushes`, `check_stash_apply_risk`, `git_blame_ownership_diff`, `git_tag_annotate_audit`, `suggest_next_version`, `check_commit_signatures`, `git_commit_frequency`, `git_orphaned_branches`, `git_submodule_status`, `git_ownership`, `git_blame_hotspots`, `git_file_age`, `find_todo_owners`, `find_stale_todos`, `generate_pr_description`, `find_large_git_objects`, `check_dotenv_files_not_gitignored`, `check_lfs_coverage`, `merge_conflict_risk`

## Code Analysis & Audit (51)

`find_files`, `check_binary_file`, `find_duplicates`, `scan_todos`, `scan_conflict_markers`, `find_binary_diffs`, `find_circular_deps`, `find_dead_exports`, `find_unused_dependencies`, `find_console_logs`, `find_duplicate_dependencies`, `readme_link_check`, `find_env_var_usage`, `check_npm_audit_cache`, `find_unreachable_modules`, `find_orphaned_test_files`, `check_test_coverage_gaps`, `check_line_endings`, `find_large_files`, `find_empty_dirs`, `package_json_audit`, `check_package_lock_sync`, `scan_dockerfile_issues`, `scan_dependency_licenses`, `find_case_sensitive_import_mismatches`, `find_duplicate_yaml_keys`, `find_unsafe_regex`, `scan_npm_lifecycle_scripts`, `check_semver_range_strictness`, `find_empty_catch_blocks`, `find_sync_fs_in_async_context`, `find_dangling_promises`, `find_unbounded_recursion`, `find_unbounded_object_growth`, `find_regex_denial_of_service_in_route_params`, `check_test_flakiness_risk`, `find_unbounded_array_push_in_loop`, `find_env_var_default_fallback_masking_errors`, `find_promise_all_without_catch`, `find_blocking_child_process_calls`, `find_unhandled_express_error_middleware`, `check_dockerignore_coverage`, `find_json_parse_without_try_catch`, `find_inconsistent_error_response_shape`, `summarize_package_scripts`, `check_docker_compose_issues`, `find_setinterval_without_clear`, `find_async_callback_in_foreach`, `find_duplicate_html_id`, `find_positive_tabindex`, `find_duplicate_json_keys`

## Security Scanning (44)

`scan_secrets`, `find_hardcoded_ips`, `find_missing_await`, `scan_cors_misconfig`, `scan_dangerous_code_patterns`, `find_unpinned_github_actions`, `find_hardcoded_credentials_in_config`, `find_hardcoded_ports`, `find_insecure_random_usage`, `find_missing_null_checks_after_regex_exec`, `check_missing_csp_header`, `find_missing_sort_comparator`, `find_req_body_mass_assignment`, `find_prototype_pollution_risk`, `check_missing_rate_limit`, `check_dependency_confusion_risk`, `find_error_message_leaking_internals`, `find_disabled_tls_verification`, `find_unpinned_docker_base_image`, `check_missing_helmet_security_headers`, `check_missing_rate_limit_headers`, `find_duplicate_route_registrations`, `find_missing_pagination_limit`, `find_missing_error_boundary_in_async_route`, `find_missing_websocket_error_handler`, `find_hardcoded_localhost_urls`, `find_open_redirect_risks`, `find_unvalidated_redirect`, `find_race_condition_risk`, `find_missing_json_response_content_type`, `find_missing_findindex_check`, `find_missing_null_check_on_optional_chaining_default`, `find_missing_cleanup_on_early_return`, `find_hardcoded_jwt_secret`, `check_insecure_cookie_flags`, `check_missing_engines_field`, `find_missing_shebang_in_bin_scripts`, `find_missing_return_after_res_send`, `find_missing_stream_error_handler`, `find_missing_img_alt_text`, `find_missing_form_label`, `find_missing_button_accessible_name`, `find_missing_rel_noopener`, `find_missing_remove_event_listener`

## Browser Automation (36)

`browser_launch`, `browser_navigate`, `browser_get_content`, `browser_get_title`, `browser_evaluate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_console_logs`, `browser_list_sessions`, `browser_close`, `browser_wait_for_navigation`, `browser_hover`, `browser_upload_file`, `browser_drag_and_drop`, `browser_download`, `browser_get_attribute`, `browser_is_checked`, `browser_uncheck`, `browser_get_element_info`, `browser_close_page`, `browser_emulate`, `browser_set_viewport`, `browser_set_extra_headers`, `browser_set_local_storage`, `browser_add_init_script`, `browser_get_page_metrics`, `browser_get_exposed_calls`, `browser_wait_for_response`, `browser_get_storage_state`, `browser_storage_state_save`, `browser_accessibility_snapshot`, `browser_find_by_role`, `browser_wait_for_dialog`, `browser_frame_evaluate`, `browser_replay_actions`

## Network & Messaging (21)

`http_fetch`, `http_download`, `port_check`, `wait_for_port`, `port_scan_range`, `dns_lookup`, `websocket_client`, `sse_client`, `smtp_client`, `redis_client`, `mqtt_client`, `imap_client`, `snmp_client`, `ftp_client`, `kafka_client`, `amqp_client`, `stomp_client`, `ldap_client`, `nats_client`, `memcached_client`, `grpc_client`

## Data & Format Utilities (27)

`json_schema_validate`, `env_diff`, `zip_directory`, `create_tar`, `read_archive`, `query_json`, `query_data`, `diff_files`, `query_path`, `json_patch_generate`, `json_diff`, `json_format`, `json_patch`, `apply_patch`, `unzip_archive`, `extract_tar`, `yaml_patch`, `yaml_merge`, `json_merge`, `convert_data`, `csv_convert`, `gzip_decompress`, `brotli_decompress`, `csv_diff`, `json_schema_generate`, `csv_query`, `json_unflatten`

## Execution & Process (7)

`run_command`, `start_process`, `get_process_output`, `kill_process`, `list_processes`, `run_npm_script`, `execute_pipeline`

## Email & Database (9)

`email_list_mailboxes`, `email_send`, `email_search`, `sqlite_create`, `sqlite_connect`, `sqlite_execute`, `sqlite_disconnect`, `sqlite_connections`, `sqlite_tables`
