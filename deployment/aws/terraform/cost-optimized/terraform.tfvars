# Cost-Optimized AWS Deployment Configuration for Nursery Management System
# This configuration leverages AWS Free Tier and serverless architecture to minimize costs

# AWS Configuration
aws_region = "ap-south-1"
environment = "production"
project_name = "nursery-backend"

# Domain Configuration
domain_name = "rambiotech.com"
hosted_zone_id = "Z02011993023GA2VOEWIO"

# Cost Optimization Settings
use_free_tier = true
deployment_type = "serverless"
enable_cost_optimization = true
use_single_az = false
enable_auto_scaling_cost_optimized = false
max_capacity_cost_optimized = 2

# VPC Configuration (Simplified for cost savings)
vpc_cidr = "10.0.0.0/16"
availability_zones = ["ap-south-1a", "ap-south-1b"] # Use only 2 AZs
public_subnet_cidrs = ["10.0.1.0/24", "10.0.2.0/24"]
private_subnet_cidrs = ["10.0.11.0/24", "10.0.12.0/24"]

# Serverless Configuration
lambda_memory_size = 512
lambda_timeout = 30

# Database Configuration (Free Tier eligible)
docdb_instance_class = "db.t3.micro" # Smallest instance
docdb_instance_count = 1 # Single instance

# Cache Configuration (Free Tier eligible)
redis_node_type = "cache.t3.micro" # Smallest instance

# CloudFront Configuration (Cost optimized)
cloudfront_price_class = "PriceClass_100" # North America and Europe only

# S3 Lifecycle Configuration (Cost optimization)
s3_lifecycle_enabled = true
s3_ia_transition_days = 30
s3_glacier_transition_days = 90
s3_expiration_days = 365
backup_expiration_days = 90

# Logging Configuration (Cost optimized)
log_retention_days_cost_optimized = 7 # Reduced retention

# Budget Configuration
monthly_budget = 50 # Monthly budget
admin_email = "vivekc.react@gmail.com"

# Security Configuration (Essential only)
enable_waf = false # Disabled for cost savings
enable_cloudtrail = false # Disabled for cost savings
enable_guardduty = false # Disabled for cost savings
enable_config = false # Disabled for cost savings

# Monitoring Configuration (Essential only)
enable_monitoring = true
enable_logging = true
enable_auto_scaling = false # Disabled for cost savings

# Tags
tags = {
  Owner       = "DevOps Team"
  CostCenter  = "IT Department"
  Environment = "production"
  Project     = "Nursery Management System"
  ManagedBy   = "Terraform"
  CostOptimized = "true"
}
