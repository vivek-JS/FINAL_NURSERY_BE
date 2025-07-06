# Cost-Optimized Infrastructure Outputs

# API Gateway
output "api_gateway_url" {
  description = "API Gateway URL"
  value       = aws_api_gateway_stage.nursery_api.invoke_url
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = aws_api_gateway_rest_api.nursery_api.id
}

# Lambda Function
output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.nursery_api.function_name
}

output "lambda_function_arn" {
  description = "Lambda function ARN"
  value       = aws_lambda_function.nursery_api.arn
}

# Frontend
output "frontend_url" {
  description = "Frontend URL"
  value       = "https://${var.domain_name}"
}

output "frontend_bucket" {
  description = "Frontend S3 bucket name"
  value       = aws_s3_bucket.frontend.bucket
}

# S3 Buckets
output "uploads_bucket" {
  description = "Uploads S3 bucket name"
  value       = aws_s3_bucket.uploads.bucket
}

output "backups_bucket" {
  description = "Backups S3 bucket name"
  value       = aws_s3_bucket.backups.bucket
}

# Database
output "docdb_cluster_endpoint" {
  description = "DocumentDB cluster endpoint"
  value       = aws_docdb_cluster.main.endpoint
}

output "docdb_cluster_identifier" {
  description = "DocumentDB cluster identifier"
  value       = aws_docdb_cluster.main.cluster_identifier
}

# Redis
output "redis_endpoint" {
  description = "Redis endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_port" {
  description = "Redis port"
  value       = aws_elasticache_replication_group.redis.port
}

# VPC
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "private_subnets" {
  description = "Private subnet IDs"
  value       = module.vpc.private_subnets
}

output "public_subnets" {
  description = "Public subnet IDs"
  value       = module.vpc.public_subnets
}

# Security Groups
output "lambda_security_group_id" {
  description = "Lambda security group ID"
  value       = aws_security_group.lambda.id
}

output "docdb_security_group_id" {
  description = "DocumentDB security group ID"
  value       = aws_security_group.docdb.id
}

output "redis_security_group_id" {
  description = "Redis security group ID"
  value       = aws_security_group.redis.id
}

# CloudWatch
output "lambda_log_group" {
  description = "Lambda CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda.name
}

# Secrets Manager
output "jwt_secret_arn" {
  description = "JWT secret ARN"
  value       = aws_secretsmanager_secret.jwt_secret.arn
}

output "refresh_token_secret_arn" {
  description = "Refresh token secret ARN"
  value       = aws_secretsmanager_secret.refresh_token_secret.arn
}

# Route53
output "route53_zone_id" {
  description = "Route53 hosted zone ID"
  value       = var.domain_name != "your-nursery-domain.com" ? var.hosted_zone_id : "N/A"
}

# ACM Certificate
output "certificate_arn" {
  description = "ACM certificate ARN"
  value       = var.domain_name != "your-nursery-domain.com" ? aws_acm_certificate.main[0].arn : "N/A"
}

# Cost Information
output "estimated_monthly_cost" {
  description = "Estimated monthly cost"
  value       = var.environment == "production" ? "~$31/month (with Free Tier)" : "~$51/month (without Free Tier)"
} 

# CloudFront
output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = length(aws_cloudfront_distribution.frontend) > 0 ? aws_cloudfront_distribution.frontend[0].id : "N/A"
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = length(aws_cloudfront_distribution.frontend) > 0 ? aws_cloudfront_distribution.frontend[0].domain_name : "N/A"
} 