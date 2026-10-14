CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "public"."ack_state" AS ENUM('PENDING', 'ACKNOWLEDGED', 'DECLINED', 'EXPIRED_ESCALATED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('STAFF', 'PROVIDER', 'GUARDIAN', 'THERAPIST', 'AGENT', 'SYSTEM', 'DEMO');--> statement-breakpoint
CREATE TYPE "public"."agent_run_state" AS ENUM('QUEUED', 'RUNNING', 'WAITING_TOOL', 'SUCCEEDED', 'FAILED', 'ABORTED_SUPERSEDED_BY_HUMAN');--> statement-breakpoint
CREATE TYPE "public"."attendance_state" AS ENUM('SCHEDULED', 'EXPECTED_LATE', 'AM_SELF_DROP', 'CHECKED_IN', 'EARLY_DEPARTURE', 'CHECKED_OUT', 'ABSENT_FULL_DAY');--> statement-breakpoint
CREATE TYPE "public"."auth_scope" AS ENUM('RECEIVE_TRANSPORT_UPDATES', 'CANCEL_LEG', 'CHANGE_PICKUP_INSTRUCTIONS', 'CONFIRM_AVAILABILITY_TO_RECEIVE', 'RECEIVE_ATTENDANCE_UPDATES', 'ACCESS_SENSITIVE_INFO', 'RECEIVE_CHILD');--> statement-breakpoint
CREATE TYPE "public"."capability_state" AS ENUM('UNKNOWN', 'REQUESTED', 'REPORTED', 'VERIFIED', 'CHANGED', 'REJECTED', 'UNAVAILABLE', 'VERIFIED_INFEASIBLE');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('SMS_1TO1', 'MMS_GROUP', 'TEAMS', 'VOICE_TASK', 'DISPATCHER_LINK');--> statement-breakpoint
CREATE TYPE "public"."dispatch_ownership" AS ENUM('CENTER_FLEET', 'THIRD_PARTY', 'BROKER_NEMT');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('SCHEDULED', 'CLAIMED', 'DONE', 'CANCELED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."leg_direction" AS ENUM('AM', 'PM');--> statement-breakpoint
CREATE TYPE "public"."leg_mode" AS ENUM('PROVIDER', 'FAMILY', 'CENTER');--> statement-breakpoint
CREATE TYPE "public"."leg_state" AS ENUM('SCHEDULED', 'PROVISIONAL_ASSIGNED', 'CAPABILITY_PENDING', 'CAPABILITY_REPORTED', 'CAPABILITY_VERIFIED', 'MANIFEST_LOCKED', 'EN_ROUTE_PICKUP', 'ARRIVED_PICKUP', 'BOARDED_REPORTED', 'BOARDED_VERIFIED', 'IN_TRANSIT', 'ARRIVED_DROPOFF', 'COMPLETED_HANDOFF', 'CANCELED_TRANSPORT', 'CANCELED_ATTENDANCE', 'NO_SHOW', 'HELD_NO_RECEIVER', 'LEFT_BEHIND_CAPACITY', 'EXCEPTION');--> statement-breakpoint
CREATE TYPE "public"."mobility" AS ENUM('AMB', 'WC');--> statement-breakpoint
CREATE TYPE "public"."need_item_state" AS ENUM('UNKNOWN', 'REPORTED', 'VERIFIED', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."outbound_state" AS ENUM('DRAFTED', 'POLICY_CHECKED', 'QUEUED', 'BLOCKED_EGRESS', 'SENDING', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED', 'UNKNOWN', 'REDACTED', 'CANCELED_STALE');--> statement-breakpoint
CREATE TYPE "public"."profile_state" AS ENUM('DRAFT', 'APPROVED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('PROVISIONAL', 'FEASIBLE', 'INFEASIBLE', 'COMMITTED', 'RELEASED', 'NEEDS_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."roi_cohort" AS ENUM('SYNTHETIC', 'BASELINE', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."securement" AS ENUM('L_TRACK', 'SLIDE_N_CLICK', 'FOUR_POINT_STRAP', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('GREEN', 'AMBER', 'RED');--> statement-breakpoint
CREATE TYPE "public"."source_mode" AS ENUM('LIVE', 'SANDBOX', 'REPLAY', 'SIMULATED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('DIRECTOR', 'COORDINATOR', 'FRONT_DESK', 'PLATFORM_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED_APPROVED', 'RESOLVED_OVERRIDE', 'CLOSED_VERIFIED', 'SNOOZED');--> statement-breakpoint
CREATE TYPE "public"."thread_state" AS ENUM('OPEN', 'PAUSED_HUMAN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "ops"."acknowledgment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"outbound_message_id" uuid NOT NULL,
	"contact_token" uuid NOT NULL,
	"state" "ack_state" DEFAULT 'PENDING' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"timer_job_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."agent_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"contact_token" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."agent_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_id" text NOT NULL,
	"state" "agent_run_state" DEFAULT 'QUEUED' NOT NULL,
	"model" text,
	"provider_routed" text,
	"prompt_hash" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."agent_tool_call" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"args" jsonb NOT NULL,
	"policy_decision" text NOT NULL,
	"result" jsonb,
	"committed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."approval_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"proposal" jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."attendance_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"service_date" date NOT NULL,
	"state" "attendance_state" DEFAULT 'SCHEDULED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."attendance_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"attendance_day_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_late" boolean DEFAULT false NOT NULL,
	"receiving_contact_token" uuid,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."attendance_exception" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"service_date" date NOT NULL,
	"scope" text NOT NULL,
	"reason" text,
	"expected_self_arrival" text,
	"change_request_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."attendance_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"rrule" text NOT NULL,
	"am_mode" "leg_mode" NOT NULL,
	"pm_mode" "leg_mode" NOT NULL,
	"am_window_start" text NOT NULL,
	"pm_window_start" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"from_version" integer,
	"to_version" integer,
	"reason" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."change_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_child_tokens" uuid[] NOT NULL,
	"basis_message_id" uuid,
	"confidence" double precision,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"superseded_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."child_identity" (
	"child_token" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"external_ehr_id" text NOT NULL,
	"legal_first_name" text NOT NULL,
	"legal_last_name" text NOT NULL,
	"dob" date,
	"address_enc" text,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."child_profile" (
	"child_token" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"family_group_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."consent_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"contact_token" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" "channel" NOT NULL,
	"evidence_message_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_mode" "source_mode" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."contact_authorization" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"contact_token" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"scope" "auth_scope" NOT NULL,
	"channel" "channel" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."conversation_thread" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"family_group_id" uuid,
	"counterparty_token" uuid,
	"channel" "channel" NOT NULL,
	"state" "thread_state" DEFAULT 'OPEN' NOT NULL,
	"owner_user_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"external_device_id" text NOT NULL,
	"adapter" text NOT NULL,
	"secret_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."device_binding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"manifest_id" uuid,
	"active_from" timestamp with time zone NOT NULL,
	"active_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."dispatcher_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"service_date" date NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."eta_estimate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"trip_leg_id" uuid NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"eta_at" timestamp with time zone NOT NULL,
	"uncertainty_sec" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"basis_telemetry_id" bigint,
	"routing_request_id" text,
	"consecutive_shift_count" smallint DEFAULT 0 NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."event_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version" integer NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."external_person_identity" (
	"person_token" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"legal_name" text NOT NULL,
	"phone_hmac" text,
	"phone_enc" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."family_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"display_label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."guardian_contact" (
	"contact_token" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"family_group_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"phone_hmac" text NOT NULL,
	"phone_enc" text NOT NULL,
	"relationship" text NOT NULL,
	"can_receive_updates" boolean DEFAULT false NOT NULL,
	"can_request_changes" boolean DEFAULT false NOT NULL,
	"can_receive_child" boolean DEFAULT false NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."idempotency_record" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"response_code" smallint NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."integration_health" (
	"adapter" text PRIMARY KEY NOT NULL,
	"mode" "source_mode" NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"breaker" text DEFAULT 'CLOSED' NOT NULL,
	"error_rate_5m" double precision,
	"queue_depth" integer
);
--> statement-breakpoint
CREATE TABLE "ops"."job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" "job_state" DEFAULT 'SCHEDULED' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"claimed_until" timestamp with time zone,
	"fired_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."job_fire_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"late_ms" integer NOT NULL,
	"path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."layout_position" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"securement" "securement",
	"max_length_cm" integer,
	"max_width_cm" integer,
	"tether_capable" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."manifest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"direction" "leg_direction" NOT NULL,
	"provider_id" uuid,
	"vehicle_id" uuid,
	"layout_id" uuid,
	"locked_at" timestamp with time zone,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."manifest_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"trip_leg_id" uuid NOT NULL,
	"state" "reservation_state" DEFAULT 'PROVISIONAL' NOT NULL,
	"position_id" uuid,
	"deficit" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"from_hmac" text NOT NULL,
	"is_own_echo" boolean DEFAULT false NOT NULL,
	"body_tokenized" text NOT NULL,
	"body_enc" text,
	"raw_payload_hash" text NOT NULL,
	"provider_index" bigint,
	"resolved_child_tokens" uuid[],
	"resolve_confidence" double precision,
	"idempotency_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."org" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."outbound_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"recipient_rule" text NOT NULL,
	"recipient_token" uuid,
	"channel" "channel" NOT NULL,
	"template_id" text NOT NULL,
	"vars" jsonb NOT NULL,
	"trip_leg_id" uuid,
	"therapy_session_id" uuid,
	"plan_version_basis" integer NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"state" "outbound_state" DEFAULT 'DRAFTED' NOT NULL,
	"block_reason" text,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."provider" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dispatch_ownership" "dispatch_ownership" NOT NULL,
	"dispatcher_person_token" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."roi_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"cohort" "roi_cohort" NOT NULL,
	"value" double precision NOT NULL,
	"ref_entity" text,
	"ref_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."runtime_marker" (
	"id" smallint PRIMARY KEY NOT NULL,
	"active_deployment_id" text NOT NULL,
	"rearmed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."scenario_clock" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"scenario" text NOT NULL,
	"anchor_real" timestamp with time zone NOT NULL,
	"anchor_scenario" timestamp with time zone NOT NULL,
	"speed" double precision DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."sim_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"track" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"speed" double precision NOT NULL,
	"faults" jsonb NOT NULL,
	"cursor_idx" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."site_membership" (
	"user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_membership_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."site" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"state_profile" text DEFAULT 'UNSET' NOT NULL,
	"depot_lat" double precision NOT NULL,
	"depot_lng" double precision NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."stop_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"label" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"child_token" uuid,
	"is_center" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."suppression" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"contact_token" uuid NOT NULL,
	"scope" text NOT NULL,
	"permanent_test" boolean DEFAULT false NOT NULL,
	"consent_event_id" uuid NOT NULL,
	"lifted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"category" text NOT NULL,
	"severity" "severity" NOT NULL,
	"state" "task_state" DEFAULT 'OPEN' NOT NULL,
	"trip_leg_id" uuid,
	"child_token" uuid,
	"prior_leg_state" "leg_state",
	"summary" text NOT NULL,
	"next_step" text,
	"owner_user_id" uuid,
	"sla_due_at" timestamp with time zone,
	"snooze_reason" text,
	"completion_predicate" text NOT NULL,
	"completion_evidence" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL,
	CONSTRAINT "task_closed_needs_evidence" CHECK (state <> 'CLOSED_VERIFIED' OR completion_evidence IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ops"."teams_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"approval_request_id" uuid,
	"card_version" integer NOT NULL,
	"activity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."teams_conversation_ref" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"ref" jsonb NOT NULL,
	"purpose" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."telemetry_point" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"speed_mps" double precision,
	"heading_deg" double precision,
	"bound" boolean NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"source_mode" "source_mode" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."therapist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"person_token" uuid NOT NULL,
	"display_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."therapy_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"therapist_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."transport_need_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"category" text NOT NULL,
	"value" jsonb NOT NULL,
	"state" "need_item_state" DEFAULT 'UNKNOWN' NOT NULL,
	"evidence_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."transport_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"status" "profile_state" DEFAULT 'DRAFT' NOT NULL,
	"mobility" "mobility" NOT NULL,
	"wc_length_cm" integer,
	"wc_width_cm" integer,
	"securement" "securement",
	"tether" boolean DEFAULT false NOT NULL,
	"escort_required" boolean DEFAULT false NOT NULL,
	"max_ride_minutes" integer,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."trip_leg" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"child_token" uuid NOT NULL,
	"service_date" date NOT NULL,
	"direction" "leg_direction" NOT NULL,
	"mode" "leg_mode" NOT NULL,
	"state" "leg_state" DEFAULT 'SCHEDULED' NOT NULL,
	"prior_state" "leg_state",
	"manifest_id" uuid,
	"stop_seq" smallint,
	"stop_location_id" uuid,
	"window_start" timestamp with time zone,
	"receiver_confirmed_at" timestamp with time zone,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."vehicle" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"provider_id" uuid,
	"label" text NOT NULL,
	"lift_equipped" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."vehicle_capability_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"state" "capability_state" DEFAULT 'UNKNOWN' NOT NULL,
	"lift_ok" boolean,
	"unavailable_position_ids" uuid[] DEFAULT '{}' NOT NULL,
	"observed_at" timestamp with time zone,
	"observed_by" text,
	"evidence_message_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."vehicle_layout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"code" text NOT NULL,
	"lift_required" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"source_mode" "source_mode" DEFAULT 'SIMULATED' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."acknowledgment" ADD CONSTRAINT "acknowledgment_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."acknowledgment" ADD CONSTRAINT "acknowledgment_outbound_message_id_outbound_message_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "ops"."outbound_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."acknowledgment" ADD CONSTRAINT "acknowledgment_timer_job_id_job_id_fk" FOREIGN KEY ("timer_job_id") REFERENCES "ops"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."agent_memory" ADD CONSTRAINT "agent_memory_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."agent_run" ADD CONSTRAINT "agent_run_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."agent_tool_call" ADD CONSTRAINT "agent_tool_call_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."agent_tool_call" ADD CONSTRAINT "agent_tool_call_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "ops"."agent_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."approval_request" ADD CONSTRAINT "approval_request_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."approval_request" ADD CONSTRAINT "approval_request_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ops"."task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_day" ADD CONSTRAINT "attendance_day_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_day" ADD CONSTRAINT "attendance_day_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_exception" ADD CONSTRAINT "attendance_exception_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_exception" ADD CONSTRAINT "attendance_exception_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_exception" ADD CONSTRAINT "attendance_exception_change_request_id_change_request_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "ops"."change_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_plan" ADD CONSTRAINT "attendance_plan_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."attendance_plan" ADD CONSTRAINT "attendance_plan_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."change_request" ADD CONSTRAINT "change_request_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."change_request" ADD CONSTRAINT "change_request_basis_message_id_message_id_fk" FOREIGN KEY ("basis_message_id") REFERENCES "ops"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."child_profile" ADD CONSTRAINT "child_profile_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."child_profile" ADD CONSTRAINT "child_profile_family_group_id_family_group_id_fk" FOREIGN KEY ("family_group_id") REFERENCES "ops"."family_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."contact_authorization" ADD CONSTRAINT "contact_authorization_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."contact_authorization" ADD CONSTRAINT "contact_authorization_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."conversation_thread" ADD CONSTRAINT "conversation_thread_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."conversation_thread" ADD CONSTRAINT "conversation_thread_family_group_id_family_group_id_fk" FOREIGN KEY ("family_group_id") REFERENCES "ops"."family_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."conversation_thread" ADD CONSTRAINT "conversation_thread_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "ops"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."device" ADD CONSTRAINT "device_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."device_binding" ADD CONSTRAINT "device_binding_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."device_binding" ADD CONSTRAINT "device_binding_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "ops"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."device_binding" ADD CONSTRAINT "device_binding_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."device_binding" ADD CONSTRAINT "device_binding_manifest_id_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ops"."manifest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dispatcher_link" ADD CONSTRAINT "dispatcher_link_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dispatcher_link" ADD CONSTRAINT "dispatcher_link_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."dispatcher_link" ADD CONSTRAINT "dispatcher_link_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."eta_estimate" ADD CONSTRAINT "eta_estimate_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."eta_estimate" ADD CONSTRAINT "eta_estimate_trip_leg_id_trip_leg_id_fk" FOREIGN KEY ("trip_leg_id") REFERENCES "ops"."trip_leg"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."family_group" ADD CONSTRAINT "family_group_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."job" ADD CONSTRAINT "job_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."layout_position" ADD CONSTRAINT "layout_position_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."layout_position" ADD CONSTRAINT "layout_position_layout_id_vehicle_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "ops"."vehicle_layout"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest" ADD CONSTRAINT "manifest_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest" ADD CONSTRAINT "manifest_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest" ADD CONSTRAINT "manifest_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest" ADD CONSTRAINT "manifest_layout_id_vehicle_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "ops"."vehicle_layout"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest_reservation" ADD CONSTRAINT "manifest_reservation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest_reservation" ADD CONSTRAINT "manifest_reservation_manifest_id_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ops"."manifest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest_reservation" ADD CONSTRAINT "manifest_reservation_trip_leg_id_trip_leg_id_fk" FOREIGN KEY ("trip_leg_id") REFERENCES "ops"."trip_leg"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."manifest_reservation" ADD CONSTRAINT "manifest_reservation_position_id_layout_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "ops"."layout_position"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."message" ADD CONSTRAINT "message_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."message" ADD CONSTRAINT "message_thread_id_conversation_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "ops"."conversation_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."outbound_message" ADD CONSTRAINT "outbound_message_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."outbound_message" ADD CONSTRAINT "outbound_message_trip_leg_id_trip_leg_id_fk" FOREIGN KEY ("trip_leg_id") REFERENCES "ops"."trip_leg"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."outbound_message" ADD CONSTRAINT "outbound_message_therapy_session_id_therapy_session_id_fk" FOREIGN KEY ("therapy_session_id") REFERENCES "ops"."therapy_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."provider" ADD CONSTRAINT "provider_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."roi_event" ADD CONSTRAINT "roi_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sim_run" ADD CONSTRAINT "sim_run_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sim_run" ADD CONSTRAINT "sim_run_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."site_membership" ADD CONSTRAINT "site_membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ops"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."site_membership" ADD CONSTRAINT "site_membership_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."site" ADD CONSTRAINT "site_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "ops"."org"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stop_location" ADD CONSTRAINT "stop_location_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stop_location" ADD CONSTRAINT "stop_location_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."suppression" ADD CONSTRAINT "suppression_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."task" ADD CONSTRAINT "task_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."task" ADD CONSTRAINT "task_trip_leg_id_trip_leg_id_fk" FOREIGN KEY ("trip_leg_id") REFERENCES "ops"."trip_leg"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."task" ADD CONSTRAINT "task_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."task" ADD CONSTRAINT "task_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "ops"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."teams_activity" ADD CONSTRAINT "teams_activity_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."teams_activity" ADD CONSTRAINT "teams_activity_approval_request_id_approval_request_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "ops"."approval_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."teams_conversation_ref" ADD CONSTRAINT "teams_conversation_ref_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."therapist" ADD CONSTRAINT "therapist_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."therapy_session" ADD CONSTRAINT "therapy_session_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."therapy_session" ADD CONSTRAINT "therapy_session_therapist_id_therapist_id_fk" FOREIGN KEY ("therapist_id") REFERENCES "ops"."therapist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."therapy_session" ADD CONSTRAINT "therapy_session_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."transport_need_item" ADD CONSTRAINT "transport_need_item_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."transport_need_item" ADD CONSTRAINT "transport_need_item_profile_id_transport_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "ops"."transport_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."transport_profile" ADD CONSTRAINT "transport_profile_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."transport_profile" ADD CONSTRAINT "transport_profile_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."trip_leg" ADD CONSTRAINT "trip_leg_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."trip_leg" ADD CONSTRAINT "trip_leg_child_token_child_profile_child_token_fk" FOREIGN KEY ("child_token") REFERENCES "ops"."child_profile"("child_token") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."trip_leg" ADD CONSTRAINT "trip_leg_manifest_id_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "ops"."manifest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."trip_leg" ADD CONSTRAINT "trip_leg_stop_location_id_stop_location_id_fk" FOREIGN KEY ("stop_location_id") REFERENCES "ops"."stop_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle" ADD CONSTRAINT "vehicle_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle" ADD CONSTRAINT "vehicle_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ops"."provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle_capability_day" ADD CONSTRAINT "vehicle_capability_day_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle_capability_day" ADD CONSTRAINT "vehicle_capability_day_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle_capability_day" ADD CONSTRAINT "vehicle_capability_day_evidence_message_id_message_id_fk" FOREIGN KEY ("evidence_message_id") REFERENCES "ops"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle_layout" ADD CONSTRAINT "vehicle_layout_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "ops"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."vehicle_layout" ADD CONSTRAINT "vehicle_layout_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."vehicle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_trigger_uq" ON "ops"."agent_run" USING btree ("trigger_type","trigger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_call_seq_uq" ON "ops"."agent_tool_call" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_uq" ON "ops"."app_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_day_uq" ON "ops"."attendance_day" USING btree ("child_token","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_event_idem_uq" ON "ops"."attendance_event" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "att_exc_child_date_idx" ON "ops"."attendance_exception" USING btree ("child_token","service_date");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "ops"."audit_event" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "child_identity_ehr_uq" ON "identity"."child_identity" USING btree ("site_id","external_ehr_id");--> statement-breakpoint
CREATE INDEX "child_profile_family_idx" ON "ops"."child_profile" USING btree ("family_group_id");--> statement-breakpoint
CREATE INDEX "consent_event_contact_idx" ON "identity"."consent_event" USING btree ("contact_token","at");--> statement-breakpoint
CREATE INDEX "contact_auth_lookup_idx" ON "ops"."contact_authorization" USING btree ("contact_token","child_token","scope");--> statement-breakpoint
CREATE INDEX "thread_family_idx" ON "ops"."conversation_thread" USING btree ("family_group_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_ext_uq" ON "ops"."device" USING btree ("adapter","external_device_id");--> statement-breakpoint
CREATE INDEX "device_binding_active_idx" ON "ops"."device_binding" USING btree ("device_id","active_from");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatcher_link_token_uq" ON "ops"."dispatcher_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "eta_leg_time_idx" ON "ops"."eta_estimate" USING btree ("trip_leg_id","computed_at");--> statement-breakpoint
CREATE INDEX "event_log_site_seq_idx" ON "ops"."event_log" USING btree ("site_id","seq");--> statement-breakpoint
CREATE INDEX "external_person_phone_hmac_idx" ON "identity"."external_person_identity" USING btree ("phone_hmac");--> statement-breakpoint
CREATE INDEX "guardian_contact_phone_hmac_idx" ON "identity"."guardian_contact" USING btree ("phone_hmac");--> statement-breakpoint
CREATE INDEX "guardian_contact_family_idx" ON "identity"."guardian_contact" USING btree ("family_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_key_live_uq" ON "ops"."job" USING btree ("key") WHERE state IN ('SCHEDULED','CLAIMED');--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "ops"."job" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "job_fire_log_job_idx" ON "ops"."job_fire_log" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "layout_position_layout_idx" ON "ops"."layout_position" USING btree ("layout_id");--> statement-breakpoint
CREATE INDEX "manifest_site_date_idx" ON "ops"."manifest" USING btree ("site_id","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "manifest_reservation_leg_uq" ON "ops"."manifest_reservation" USING btree ("manifest_id","trip_leg_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_provider_ext_uq" ON "ops"."message" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "ops"."message" USING btree ("thread_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_idem_uq" ON "ops"."outbound_message" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_drain_idx" ON "ops"."outbound_message" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbound_leg_idx" ON "ops"."outbound_message" USING btree ("trip_leg_id");--> statement-breakpoint
CREATE INDEX "roi_metric_idx" ON "ops"."roi_event" USING btree ("site_id","metric","cohort");--> statement-breakpoint
CREATE INDEX "suppression_contact_idx" ON "ops"."suppression" USING btree ("contact_token");--> statement-breakpoint
CREATE INDEX "task_open_idx" ON "ops"."task" USING btree ("site_id","state","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_dedupe_uq" ON "ops"."telemetry_point" USING btree ("device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "telemetry_vehicle_time_idx" ON "ops"."telemetry_point" USING btree ("vehicle_id","recorded_at");--> statement-breakpoint
CREATE INDEX "therapy_child_time_idx" ON "ops"."therapy_session" USING btree ("child_token","starts_at");--> statement-breakpoint
CREATE INDEX "need_item_profile_idx" ON "ops"."transport_need_item" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_profile_child_ver_uq" ON "ops"."transport_profile" USING btree ("child_token","profile_version");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_profile_one_approved_uq" ON "ops"."transport_profile" USING btree ("child_token") WHERE status = 'APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX "trip_leg_child_date_dir_uq" ON "ops"."trip_leg" USING btree ("child_token","service_date","direction");--> statement-breakpoint
CREATE INDEX "trip_leg_board_idx" ON "ops"."trip_leg" USING btree ("site_id","service_date","state");--> statement-breakpoint
CREATE INDEX "trip_leg_manifest_idx" ON "ops"."trip_leg" USING btree ("manifest_id","stop_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_capability_day_uq" ON "ops"."vehicle_capability_day" USING btree ("vehicle_id","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_layout_code_uq" ON "ops"."vehicle_layout" USING btree ("vehicle_id","code");