# AWS Deployment Outputs for Nursery Management System

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = aws_lb.main.zone_id
}

output "app_url" {
  description = "URL of the deployed application"
  value       = "https://${var.domain_name}"
}

output "health_check_url" {
  description = "Health check URL for the application"
  value       = "https://${var.domain_name}/health"
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.app.name
}

output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.app.repository_url
}

output "docdb_endpoint" {
  description = "DocumentDB cluster endpoint"
  value       = aws_docdb_cluster.main.endpoint
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "vpc_id" {
  description = "ID of the VPC"
  value       = module.vpc.vpc_id
}

output "private_subnets" {
  description = "IDs of the private subnets"
  value       = module.vpc.private_subnets
}

output "public_subnets" {
  description = "IDs of the public subnets"
  value       = module.vpc.public_subnets
}

output "alb_security_group_id" {
  description = "ID of the ALB security group"
  value       = aws_security_group.alb.id
}

output "ecs_security_group_id" {
  description = "ID of the ECS security group"
  value       = aws_security_group.ecs.id
}

output "docdb_security_group_id" {
  description = "ID of the DocumentDB security group"
  value       = aws_security_group.rds.id
}

output "redis_security_group_id" {
  description = "ID of the Redis security group"
  value       = aws_security_group.redis.id
}

output "s3_uploads_bucket" {
  description = "Name of the S3 bucket for uploads"
  value       = aws_s3_bucket.uploads.bucket
}

output "s3_backups_bucket" {
  description = "Name of the S3 bucket for backups"
  value       = aws_s3_bucket.backups.bucket
}

output "cloudwatch_log_group" {
  description = "Name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.app.name
}

output "acm_certificate_arn" {
  description = "ARN of the ACM certificate"
  value       = aws_acm_certificate.main.arn
}

output "route53_zone_id" {
  description = "ID of the Route53 hosted zone"
  value       = data.aws_route53_zone.main.zone_id
}

output "secrets_manager_jwt_secret_arn" {
  description = "ARN of the JWT secret in Secrets Manager"
  value       = aws_secretsmanager_secret.jwt_secret.arn
}

output "secrets_manager_refresh_token_secret_arn" {
  description = "ARN of the refresh token secret in Secrets Manager"
  value       = aws_secretsmanager_secret.refresh_token_secret.arn
}

output "deployment_summary" {
  description = "Summary of the deployment"
  value = {
    application_url = "https://${var.domain_name}"
    health_check    = "https://${var.domain_name}/health"
    environment     = var.environment
    region          = var.aws_region
    vpc_id          = module.vpc.vpc_id
    cluster_name    = aws_ecs_cluster.main.name
    service_name    = aws_ecs_service.app.name
    database        = aws_docdb_cluster.main.endpoint
    cache           = aws_elasticache_replication_group.redis.primary_endpoint_address
    load_balancer   = aws_lb.main.dns_name
  }
} 