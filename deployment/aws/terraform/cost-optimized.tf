# Cost-Optimized AWS Infrastructure for Nursery Management System
# Leverages AWS Free Tier and serverless architecture to minimize costs

# API Gateway for serverless API
resource "aws_api_gateway_rest_api" "nursery_api" {
  name = "${var.project_name}-api"
  
  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = {
    Name = "${var.project_name}-api-gateway"
  }
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.nursery_api.id
  parent_id   = aws_api_gateway_rest_api.nursery_api.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.nursery_api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "lambda" {
  rest_api_id = aws_api_gateway_rest_api.nursery_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = aws_lambda_function.nursery_api.invoke_arn
}

resource "aws_api_gateway_deployment" "nursery_api" {
  depends_on = [
    aws_api_gateway_integration.lambda,
  ]

  rest_api_id = aws_api_gateway_rest_api.nursery_api.id
  stage_name  = var.environment
}

# Lambda function for serverless backend
resource "aws_lambda_function" "nursery_api" {
  filename         = "lambda-package.zip"
  function_name    = "${var.project_name}-api"
  role            = aws_iam_role.lambda_execution_role.arn
  handler         = "index.handler"
  runtime         = "nodejs18.x"
  timeout         = 30
  memory_size     = 512

  environment {
    variables = {
      NODE_ENV = var.environment
      MONGO_URL = "mongodb://${aws_docdb_cluster.main.master_username}:${random_password.docdb_password.result}@${aws_docdb_cluster.main.endpoint}:27017/${var.project_name}_${var.environment}?retryWrites=false"
      REDIS_URL = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
    }
  }

  tags = {
    Name = "${var.project_name}-lambda-api"
  }
}

# Lambda execution role
resource "aws_iam_role" "lambda_execution_role" {
  name = "${var.project_name}-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.nursery_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.nursery_api.execution_arn}/*/*"
}

# S3 bucket for frontend hosting (Free Tier eligible)
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${random_string.bucket_suffix.result}"

  tags = {
    Name = "${var.project_name}-frontend"
  }
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "error.html"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.frontend.arn}/*"
      }
    ]
  })
}

# CloudFront distribution for frontend (Free Tier eligible)
resource "aws_cloudfront_distribution" "frontend" {
  origin {
    domain_name = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id   = "S3-${aws_s3_bucket.frontend.bucket}"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.frontend.cloudfront_access_identity_path
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # Use only North America and Europe

  aliases = [var.domain_name]

  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.bucket}"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  # Cache behavior for API calls
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "api-gateway"

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type"]
      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  custom_error_response {
    error_code         = 404
    response_code      = "200"
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.main.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "${var.project_name}-cloudfront"
  }
}

resource "aws_cloudfront_origin_access_identity" "frontend" {
  comment = "OAI for ${var.project_name} frontend"
}

# Route53 record for frontend
resource "aws_route53_record" "frontend" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# Route53 record for API subdomain
resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# Cost optimization: Use smaller DocumentDB instance (Free Tier eligible)
resource "aws_docdb_cluster" "main" {
  cluster_identifier      = "${var.project_name}-docdb"
  engine                  = "docdb"
  master_username         = "nursery_admin"
  master_password         = random_password.docdb_password.result
  db_subnet_group_name    = aws_docdb_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  skip_final_snapshot     = var.environment != "production"
  deletion_protection     = var.environment == "production"
  backup_retention_period = 1 # Reduced for cost savings
  preferred_backup_window = "03:00-04:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"

  tags = {
    Name = "${var.project_name}-docdb-cluster"
  }
}

resource "aws_docdb_cluster_instance" "cluster_instances" {
  count              = 1 # Single instance for cost savings
  identifier         = "${var.project_name}-docdb-${count.index}"
  cluster_identifier = aws_docdb_cluster.main.id
  instance_class     = "db.t3.micro" # Smallest instance for cost savings

  tags = {
    Name = "${var.project_name}-docdb-instance-${count.index}"
  }
}

# Cost optimization: Use smaller Redis instance (Free Tier eligible)
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id          = "${var.project_name}-redis"
  replication_group_description = "Redis cluster for ${var.project_name}"
  node_type                     = "cache.t3.micro" # Smallest instance for cost savings
  port                          = 6379
  parameter_group_name          = "default.redis7"
  automatic_failover_enabled    = false # Disabled for cost savings
  num_cache_clusters            = 1 # Single node for cost savings
  subnet_group_name             = aws_elasticache_subnet_group.redis.name
  security_group_ids            = [aws_security_group.redis.id]

  tags = {
    Name = "${var.project_name}-redis"
  }
}

# Cost optimization: Simplified VPC (Free Tier eligible)
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"

  name = "${var.project_name}-vpc"
  cidr = var.vpc_cidr

  azs             = [var.availability_zones[0], var.availability_zones[1]] # Use only 2 AZs
  private_subnets = [var.private_subnet_cidrs[0], var.private_subnet_cidrs[1]]
  public_subnets  = [var.public_subnet_cidrs[0], var.public_subnet_cidrs[1]]

  enable_nat_gateway = true
  single_nat_gateway = true # Use single NAT gateway for cost savings
  enable_vpn_gateway = false

  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }
}

# Cost optimization: CloudWatch log retention (Free Tier: 5GB storage, 5GB ingestion)
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}-api"
  retention_in_days = 7 # Reduced retention for cost savings

  tags = {
    Name = "${var.project_name}-lambda-logs"
  }
}

# Cost optimization: S3 lifecycle policies
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "cost_optimization"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "backup_retention"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 90 # Reduced retention for cost savings
    }
  }
}

# Cost optimization: CloudWatch alarms with reduced frequency
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.project_name}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = "300" # 5 minutes
  statistic           = "Sum"
  threshold           = "0"
  alarm_description   = "Lambda function errors"
  alarm_actions       = []

  dimensions = {
    FunctionName = aws_lambda_function.nursery_api.function_name
  }
}

# Cost optimization: Budget alerts
resource "aws_budgets_budget" "cost" {
  name              = "${var.project_name}-monthly-budget"
  budget_type       = "COST"
  limit_amount      = "50" # $50 monthly budget
  limit_unit        = "USD"
  time_period_start = "2024-01-01_00:00"
  time_unit         = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
} 