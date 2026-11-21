/**
 * AWS tools — CloudWatch, RDS, ECS, EC2, ALB, S3.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from "@aws-sdk/client-rds";
import { ECSClient, ListClustersCommand, ListServicesCommand, ListTasksCommand, DescribeTasksCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { getEffectiveSettings } from "../config.js";

// ---------------------------------------------------------------------------
// Client factory helpers
// ---------------------------------------------------------------------------

function clientConfig(region?: string) {
  const cfg = getEffectiveSettings().aws;
  const credentials = cfg.access_key_id && cfg.secret_access_key
    ? { accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key }
    : fromSSO({ profile: cfg.profile || "default" });
  return { region: region || cfg.region, credentials } as const;
}

function makeRDSClient(region?: string)  { return new RDSClient(clientConfig(region)); }
function makeECSClient(region?: string)  { return new ECSClient(clientConfig(region)); }
function makeEC2Client(region?: string)  { return new EC2Client(clientConfig(region)); }
function makeALBClient(region?: string)  { return new ElasticLoadBalancingV2Client(clientConfig(region)); }
// Buckets live in many regions; follow S3's redirect instead of failing on the configured one.
function makeS3Client(region?: string)   { return new S3Client({ ...clientConfig(region), followRegionRedirects: true }); }


function makeClient(region?: string): CloudWatchLogsClient {
  const cfg = getEffectiveSettings().aws;
  console.log(`[aws] makeClient: region=${region || cfg.region} profile=${cfg.profile || "(none)"} explicit_key=${!!cfg.access_key_id}`);
  const { region: r, credentials } = clientConfig(region);
  const loggingCreds = async (input?: unknown) => {
    const creds = await (credentials as (i?: unknown) => Promise<{ accessKeyId: string; sessionToken?: string; expiration?: Date }>)(input);
    console.log(`[aws] resolved credentials: keyId=${creds.accessKeyId.slice(0, 8)}... hasSession=${!!creds.sessionToken} expires=${creds.expiration?.toISOString() ?? "n/a"}`);
    return creds;
  };
  return new CloudWatchLogsClient({ region: r, credentials: loggingCreds as never });
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export async function cloudwatchSearch(args: {
  log_group: string;
  query: string;
  hours_back?: number;
  limit?: number;
  region?: string;
}): Promise<string> {
  const { log_group, query, hours_back = 1, limit = 50, region } = args;

  const hoursBack = Math.min(Math.max(hours_back, 1), 72);
  const effectiveLimit = Math.min(limit, 200);

  try {
    const client = makeClient(region);

    const endMs = Date.now();
    const startMs = endMs - hoursBack * 60 * 60 * 1000;

    const startRes = await client.send(
      new StartQueryCommand({
        logGroupName: log_group,
        startTime: Math.floor(startMs / 1000),
        endTime: Math.floor(endMs / 1000),
        queryString: query,
        limit: effectiveLimit,
      })
    );

    const queryId = startRes.queryId;
    if (!queryId) return "Failed to start CloudWatch Insights query.";

    // Poll until complete (up to 30 seconds)
    let results: Array<Array<{ field?: string; value?: string }>> = [];
    let status = "Running";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await client.send(new GetQueryResultsCommand({ queryId }));
      status = res.status ?? "Unknown";
      if (status === "Complete") {
        results = (res.results ?? []) as typeof results;
        break;
      }
      if (status === "Failed" || status === "Cancelled") break;
    }

    if (status !== "Complete") {
      return `Query did not complete: status=${status}`;
    }

    if (results.length === 0) {
      return "No log events found matching the query.";
    }

    const lines = results.map((event) => {
      const fields: Record<string, string> = {};
      for (const f of event) {
        if (f.field && f.value !== undefined) fields[f.field] = f.value;
      }
      const ts = fields["@timestamp"] ?? "";
      const msg = fields["@message"] ?? JSON.stringify(fields);
      return ts ? `[${ts}] ${msg}` : msg;
    });

    return lines.join("\n");
  } catch (err) {
    return `CloudWatch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function cloudwatchListLogGroups(args: {
  prefix?: string;
  limit?: number;
  region?: string;
}): Promise<string> {
  const { prefix, limit = 50, region } = args;
  try {
    const client = makeClient(region);
    const groups: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await client.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix || undefined,
        limit: Math.min(limit - groups.length, 50),
        nextToken,
      }));
      for (const g of res.logGroups ?? []) {
        if (g.logGroupName) groups.push(g.logGroupName);
      }
      nextToken = res.nextToken;
    } while (nextToken && groups.length < limit);

    if (groups.length === 0) return prefix ? `No log groups found with prefix "${prefix}".` : "No log groups found.";
    return groups.join("\n");
  } catch (err) {
    return `CloudWatch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// RDS
// ---------------------------------------------------------------------------

export async function rdsListInstances(args: { region?: string } = {}): Promise<string> {
  try {
    const client = makeRDSClient(args.region);
    const [instRes, clusterRes] = await Promise.all([
      client.send(new DescribeDBInstancesCommand({})),
      client.send(new DescribeDBClustersCommand({})),
    ]);
    const lines: string[] = [];
    for (const i of instRes.DBInstances ?? []) {
      lines.push(`instance  ${i.DBInstanceIdentifier}  ${i.Engine}@${i.EngineVersion}  ${i.DBInstanceStatus}  ${i.Endpoint?.Address ?? "no-endpoint"}:${i.Endpoint?.Port ?? ""}`);
    }
    for (const c of clusterRes.DBClusters ?? []) {
      lines.push(`cluster   ${c.DBClusterIdentifier}  ${c.Engine}@${c.EngineVersion}  ${c.Status}  ${c.ReaderEndpoint ?? c.Endpoint ?? "no-endpoint"}`);
    }
    if (lines.length === 0) return "No RDS instances or clusters found.";
    return lines.join("\n");
  } catch (err) {
    return `RDS error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// ECS
// ---------------------------------------------------------------------------

export async function ecsListClusters(args: { region?: string } = {}): Promise<string> {
  try {
    const client = makeECSClient(args.region);
    const res = await client.send(new ListClustersCommand({}));
    const arns = res.clusterArns ?? [];
    if (arns.length === 0) return "No ECS clusters found.";
    return arns.map((a) => a.split("/").pop()!).join("\n");
  } catch (err) {
    return `ECS error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function ecsListServices(args: { cluster: string; region?: string }): Promise<string> {
  try {
    const client = makeECSClient(args.region);
    const services: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await client.send(new ListServicesCommand({ cluster: args.cluster, nextToken }));
      services.push(...(res.serviceArns ?? []).map((a) => a.split("/").pop()!));
      nextToken = res.nextToken;
    } while (nextToken);
    if (services.length === 0) return `No services found in cluster "${args.cluster}".`;
    return services.join("\n");
  } catch (err) {
    return `ECS error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function ecsDescribeService(args: { cluster: string; service: string; region?: string }): Promise<string> {
  try {
    const client = makeECSClient(args.region);
    const res = await client.send(new DescribeServicesCommand({ cluster: args.cluster, services: [args.service] }));
    const svc = res.services?.[0];
    if (!svc) return `Service "${args.service}" not found in cluster "${args.cluster}".`;
    const lines = [
      `Service: ${svc.serviceName}`,
      `Status: ${svc.status}  Running: ${svc.runningCount}  Desired: ${svc.desiredCount}  Pending: ${svc.pendingCount}`,
      `Task definition: ${svc.taskDefinition}`,
      `Launch type: ${svc.launchType ?? "n/a"}`,
    ];
    if ((svc.events ?? []).length > 0) {
      lines.push("", "Recent events:");
      for (const e of (svc.events ?? []).slice(0, 5)) {
        lines.push(`  [${e.createdAt?.toISOString()}] ${e.message}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `ECS error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function ecsListTasks(args: { cluster: string; service?: string; status?: string; region?: string }): Promise<string> {
  try {
    const client = makeECSClient(args.region);
    const listRes = await client.send(new ListTasksCommand({
      cluster: args.cluster,
      serviceName: args.service || undefined,
      desiredStatus: (args.status?.toUpperCase() as "RUNNING" | "STOPPED" | "PENDING") || "RUNNING",
    }));
    const taskArns = listRes.taskArns ?? [];
    if (taskArns.length === 0) return "No tasks found.";
    const descRes = await client.send(new DescribeTasksCommand({ cluster: args.cluster, tasks: taskArns }));
    const lines = (descRes.tasks ?? []).map((t) => {
      const id = t.taskArn?.split("/").pop();
      const def = t.taskDefinitionArn?.split("/").pop();
      const health = t.healthStatus ?? "UNKNOWN";
      const cpu = t.cpu ?? "?";
      const mem = t.memory ?? "?";
      const started = t.startedAt?.toISOString() ?? "not started";
      const stopReason = t.stoppedReason ? ` STOP: ${t.stoppedReason}` : "";
      return `${id}  ${t.lastStatus}/${health}  def=${def}  cpu=${cpu} mem=${mem}  started=${started}${stopReason}`;
    });
    return lines.join("\n");
  } catch (err) {
    return `ECS error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// EC2
// ---------------------------------------------------------------------------

export async function ec2ListInstances(args: { filter?: string; state?: string; region?: string }): Promise<string> {
  try {
    const client = makeEC2Client(args.region);
    const filters = [];
    if (args.state) filters.push({ Name: "instance-state-name", Values: [args.state] });
    if (args.filter) filters.push({ Name: "tag:Name", Values: [`*${args.filter}*`] });
    const res = await client.send(new DescribeInstancesCommand({ Filters: filters.length ? filters : undefined }));
    const lines: string[] = [];
    for (const r of res.Reservations ?? []) {
      for (const i of r.Instances ?? []) {
        const name = i.Tags?.find((t) => t.Key === "Name")?.Value ?? "(no name)";
        const ip = i.PrivateIpAddress ?? i.PublicIpAddress ?? "no-ip";
        lines.push(`${i.InstanceId}  ${i.InstanceType}  ${i.State?.Name}  ${ip}  ${name}`);
      }
    }
    if (lines.length === 0) return "No EC2 instances found.";
    return lines.join("\n");
  } catch (err) {
    return `EC2 error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// ALB
// ---------------------------------------------------------------------------

export async function albListLoadBalancers(args: { name_filter?: string; region?: string }): Promise<string> {
  try {
    const client = makeALBClient(args.region);
    const res = await client.send(new DescribeLoadBalancersCommand({}));
    let lbs = res.LoadBalancers ?? [];
    if (args.name_filter) lbs = lbs.filter((lb) => lb.LoadBalancerName?.includes(args.name_filter!));
    if (lbs.length === 0) return "No load balancers found.";
    return lbs.map((lb) => `${lb.LoadBalancerName}  ${lb.Type}  ${lb.State?.Code}  ${lb.DNSName}`).join("\n");
  } catch (err) {
    return `ALB error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function albTargetHealth(args: { load_balancer_name: string; region?: string }): Promise<string> {
  try {
    const client = makeALBClient(args.region);
    const lbRes = await client.send(new DescribeLoadBalancersCommand({ Names: [args.load_balancer_name] }));
    const lb = lbRes.LoadBalancers?.[0];
    if (!lb) return `Load balancer "${args.load_balancer_name}" not found.`;
    const tgRes = await client.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
    const lines: string[] = [];
    for (const tg of tgRes.TargetGroups ?? []) {
      const healthRes = await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
      for (const h of healthRes.TargetHealthDescriptions ?? []) {
        const reason = h.TargetHealth?.Reason ? ` (${h.TargetHealth.Reason}: ${h.TargetHealth.Description})` : "";
        lines.push(`${tg.TargetGroupName}  ${h.Target?.Id}:${h.Target?.Port}  ${h.TargetHealth?.State}${reason}`);
      }
    }
    if (lines.length === 0) return "No target health data found.";
    return lines.join("\n");
  } catch (err) {
    return `ALB error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// S3 (read-only)
// ---------------------------------------------------------------------------

const S3_MAX_BUCKETS = 500;
const S3_DEFAULT_OBJECTS = 100;
const S3_MAX_OBJECTS = 1000;
const S3_DEFAULT_READ_BYTES = 64 * 1024;
const S3_MAX_READ_BYTES = 512 * 1024;
const BINARY_CONTENT_TYPE = /^(image|audio|video|font)\/|^application\/(octet-stream|zip|gzip|x-gzip|x-tar|pdf|x-parquet|vnd\.apache\.parquet|x-protobuf)/i;

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export async function s3ListBuckets(args: { name_filter?: string; region?: string } = {}): Promise<string> {
  try {
    const client = makeS3Client(args.region);
    const filter = args.name_filter?.toLowerCase();
    const lines: string[] = [];
    let total = 0;
    let token: string | undefined;
    do {
      const res = await client.send(new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }));
      for (const b of res.Buckets ?? []) {
        if (!b.Name || (filter && !b.Name.toLowerCase().includes(filter))) continue;
        total++;
        if (lines.length < S3_MAX_BUCKETS) {
          lines.push(`${b.Name}  created=${b.CreationDate?.toISOString().slice(0, 10) ?? "?"}${b.BucketRegion ? `  ${b.BucketRegion}` : ""}`);
        }
      }
      token = res.ContinuationToken;
    } while (token);
    if (total === 0) return filter ? `No buckets found matching "${args.name_filter}".` : "No S3 buckets found.";
    if (total > lines.length) lines.push(`… ${total - lines.length} more. Narrow with name_filter.`);
    return lines.join("\n");
  } catch (err) {
    return `S3 error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function s3ListObjects(args: {
  bucket: string;
  prefix?: string;
  recursive?: boolean;
  limit?: number;
  continuation_token?: string;
  region?: string;
}): Promise<string> {
  const limit = Math.min(Math.max(args.limit ?? S3_DEFAULT_OBJECTS, 1), S3_MAX_OBJECTS);
  try {
    const client = makeS3Client(args.region);
    const res = await client.send(new ListObjectsV2Command({
      Bucket: args.bucket,
      Prefix: args.prefix || undefined,
      Delimiter: args.recursive ? undefined : "/",
      MaxKeys: limit,
      ContinuationToken: args.continuation_token || undefined,
    }));
    const folders = (res.CommonPrefixes ?? []).map((p) => p.Prefix).filter((p): p is string => Boolean(p));
    const objects = res.Contents ?? [];
    const where = `s3://${args.bucket}/${args.prefix ?? ""}`;
    if (folders.length === 0 && objects.length === 0) return `Nothing found under ${where}.`;

    const lines = [where];
    if (folders.length) lines.push("", "Folders:", ...folders.map((p) => `  ${p}`));
    if (objects.length) {
      lines.push("", "Objects:");
      for (const o of objects) {
        lines.push(`  ${o.Key}  ${formatBytes(o.Size)}  ${o.LastModified?.toISOString() ?? ""}${o.StorageClass && o.StorageClass !== "STANDARD" ? `  ${o.StorageClass}` : ""}`);
      }
    }
    if (res.IsTruncated && res.NextContinuationToken) {
      lines.push("", `More results: call again with continuation_token="${res.NextContinuationToken}".`);
    }
    return lines.join("\n");
  } catch (err) {
    return `S3 error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function s3ReadObject(args: {
  bucket: string;
  key: string;
  offset?: number;
  max_bytes?: number;
  region?: string;
}): Promise<string> {
  const offset = Math.max(Math.floor(args.offset ?? 0), 0);
  const maxBytes = Math.min(Math.max(Math.floor(args.max_bytes ?? S3_DEFAULT_READ_BYTES), 1), S3_MAX_READ_BYTES);
  const uri = `s3://${args.bucket}/${args.key}`;
  try {
    const client = makeS3Client(args.region);
    const res = await client.send(new GetObjectCommand({
      Bucket: args.bucket,
      Key: args.key,
      Range: `bytes=${offset}-${offset + maxBytes - 1}`,
    }));
    const total = Number(res.ContentRange?.split("/")[1]) || (offset === 0 ? res.ContentLength : undefined);
    const header = `${uri}  ${formatBytes(total)}  ${res.ContentType ?? "unknown type"}  modified=${res.LastModified?.toISOString() ?? "?"}`;
    const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();

    const compressed = /gzip|br|deflate|zstd/i.test(res.ContentEncoding ?? "") || /\.(gz|zip|bz2|zst|parquet)$/i.test(args.key);
    if (compressed || BINARY_CONTENT_TYPE.test(res.ContentType ?? "") || bytes.subarray(0, 8192).includes(0)) {
      return `${header}\n\nBinary or compressed content; not shown.`;
    }

    const end = offset + bytes.length;
    const more = total !== undefined && end < total;
    const range = offset > 0 || more ? `\nShowing bytes ${offset}-${end - 1}${total !== undefined ? ` of ${total}` : ""}.${more ? ` Call again with offset=${end} to read more.` : ""}` : "";
    return `${header}${range}\n\n${new TextDecoder().decode(bytes)}`;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "InvalidRange") return `${uri}: offset ${offset} is past the end of the object.`;
    return `S3 error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

export const awsTools: Tool[] = [
  {
    name: "cloudwatch_list_log_groups_tool",
    description:
      "List available AWS CloudWatch log groups. Use this first when you don't know which log group to search. Optionally filter by prefix (e.g. '/aws/lambda' or a service name).",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      prefix: Type.Optional(Type.String({ description: "Optional prefix to filter log group names, e.g. '/aws/lambda/my-service'." })),
      limit: Type.Optional(Type.Integer({ description: "Max number of groups to return (default 50).", minimum: 1, maximum: 200 })),
    }),
  },
  {
    name: "cloudwatch_search_tool",
    description:
      "Search AWS CloudWatch logs using CloudWatch Insights queries. Use cloudwatch_list_log_groups_tool first if you don't know the log group name.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      log_group: Type.String({ description: "CloudWatch log group name." }),
      query: Type.String({ description: "CloudWatch Insights query string." }),
      hours_back: Type.Optional(
        Type.Integer({
          description: "How many hours back to search (1-72).",
          minimum: 1,
          maximum: 72,
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of log events to return (max 200).",
          minimum: 1,
          maximum: 200,
        })
      ),
    }),
  },
  // RDS
  {
    name: "rds_list_instances_tool",
    description: "List all RDS database instances and Aurora clusters with their endpoints, engine versions, and status.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
    }),
  },
  // ECS
  {
    name: "ecs_list_clusters_tool",
    description: "List all ECS clusters.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
    }),
  },
  {
    name: "ecs_list_services_tool",
    description: "List all ECS services in a cluster.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      cluster: Type.String({ description: "ECS cluster name or ARN." }),
    }),
  },
  {
    name: "ecs_describe_service_tool",
    description: "Describe an ECS service — running/desired counts, task definition, and recent events. Use when investigating deployment or scaling issues.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      cluster: Type.String({ description: "ECS cluster name or ARN." }),
      service: Type.String({ description: "ECS service name." }),
    }),
  },
  {
    name: "ecs_list_tasks_tool",
    description: "List running (or stopped) tasks in an ECS cluster, with health, CPU/memory, and stop reasons.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      cluster: Type.String({ description: "ECS cluster name or ARN." }),
      service: Type.Optional(Type.String({ description: "Filter by service name." })),
      status: Type.Optional(Type.String({ description: "Task status: RUNNING (default), STOPPED, or PENDING." })),
    }),
  },
  // EC2
  {
    name: "ec2_list_instances_tool",
    description: "List EC2 instances. Optionally filter by Name tag substring or instance state (running, stopped, etc.).",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      filter: Type.Optional(Type.String({ description: "Substring to match against the Name tag." })),
      state: Type.Optional(Type.String({ description: "Instance state: running, stopped, terminated, etc." })),
    }),
  },
  // ALB
  {
    name: "alb_list_load_balancers_tool",
    description: "List Application/Network Load Balancers with their state and DNS names.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      name_filter: Type.Optional(Type.String({ description: "Substring to filter load balancer names." })),
    }),
  },
  {
    name: "alb_target_health_tool",
    description: "Check the health of all targets behind a load balancer's target groups. Use when investigating 502/503 errors or unhealthy instances.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      load_balancer_name: Type.String({ description: "Load balancer name (not ARN)." }),
    }),
  },
  // S3
  {
    name: "s3_list_buckets_tool",
    description: "List S3 buckets with creation dates. Use this first when you don't know the bucket name.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      name_filter: Type.Optional(Type.String({ description: "Case-insensitive substring to filter bucket names." })),
    }),
  },
  {
    name: "s3_list_objects_tool",
    description:
      "List objects in an S3 bucket under a prefix, like a directory listing: sub-folders and objects with size and last-modified time. " +
      "Set recursive=true to list every key under the prefix.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      bucket: Type.String({ description: "Bucket name (no s3:// prefix)." }),
      prefix: Type.Optional(Type.String({ description: "Key prefix, e.g. 'logs/2026/11/'. End with '/' to list a folder." })),
      recursive: Type.Optional(Type.Boolean({ description: "List all keys under the prefix instead of one folder level (default false)." })),
      limit: Type.Optional(Type.Integer({ description: `Max keys to return (default ${S3_DEFAULT_OBJECTS}).`, minimum: 1, maximum: S3_MAX_OBJECTS })),
      continuation_token: Type.Optional(Type.String({ description: "Token from a previous call to get the next page." })),
    }),
  },
  {
    name: "s3_read_object_tool",
    description:
      "Read a text object from S3 (JSON, CSV, logs, config). Returns up to max_bytes starting at offset; use offset to page through large files. " +
      "Binary and compressed objects return metadata only.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "AWS region override, e.g. 'us-east-1'. Defaults to configured region." })),
      bucket: Type.String({ description: "Bucket name (no s3:// prefix)." }),
      key: Type.String({ description: "Full object key." }),
      offset: Type.Optional(Type.Integer({ description: "Byte offset to start reading from (default 0).", minimum: 0 })),
      max_bytes: Type.Optional(
        Type.Integer({ description: `Max bytes to read (default ${S3_DEFAULT_READ_BYTES}).`, minimum: 1, maximum: S3_MAX_READ_BYTES })
      ),
    }),
  },
];
