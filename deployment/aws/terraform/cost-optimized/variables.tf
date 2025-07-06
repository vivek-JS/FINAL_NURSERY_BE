# AWS Deployment Variables for Nursery Management System

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
  
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be one of: development, staging, production."
  }
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "nursery-backend"
}

variable "domain_name" {
  description = "Domain name for the application"
  type        = string
  default     = "your-domain.com"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones for deployment"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
}

variable "app_cpu" {
  description = "CPU units for ECS task (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "app_memory" {
  description = "Memory for ECS task in MB"
  type        = number
  default     = 1024
}

variable "app_desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 2
}

variable "docdb_instance_class" {
  description = "DocumentDB instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "docdb_instance_count" {
  description = "Number of DocumentDB instances"
  type        = number
  default     = 1
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "enable_auto_scaling" {
  description = "Enable auto scaling for ECS service"
  type        = bool
  default     = true
}

variable "min_capacity" {
  description = "Minimum number of ECS tasks"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of ECS tasks"
  type        = number
  default     = 10
}

variable "scale_up_threshold" {
  description = "CPU threshold for scaling up"
  type        = number
  default     = 70
}

variable "scale_down_threshold" {
  description = "CPU threshold for scaling down"
  type        = number
  default     = 30
}

variable "backup_retention_days" {
  description = "Number of days to retain backups"
  type        = number
  default     = 30
}

variable "enable_monitoring" {
  description = "Enable CloudWatch monitoring"
  type        = bool
  default     = true
}

variable "enable_logging" {
  description = "Enable application logging"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Number of days to retain logs"
  type        = number
  default     = 30
}

variable "enable_waf" {
  description = "Enable AWS WAF for additional security"
  type        = bool
  default     = true
}

variable "enable_cloudtrail" {
  description = "Enable CloudTrail for audit logging"
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Enable GuardDuty for threat detection"
  type        = bool
  default     = true
}

variable "enable_config" {
  description = "Enable AWS Config for compliance monitoring"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags for resources"
  type        = map(string)
  default = {
    Owner       = "DevOps"
    CostCenter  = "IT"
    Environment = "production"
  }
}

# Cost Optimization Variables

variable "use_free_tier" {
  description = "Use AWS Free Tier eligible resources"
  type        = bool
  default     = true
}

variable "deployment_type" {
  description = "Deployment type: serverless or container"
  type        = string
  default     = "serverless"
  
  validation {
    condition     = contains(["serverless", "container"], var.deployment_type)
    error_message = "Deployment type must be either 'serverless' or 'container'."
  }
}

variable "lambda_memory_size" {
  description = "Lambda function memory size in MB"
  type        = number
  default     = 512
}

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 30
}

variable "cloudfront_price_class" {
  description = "CloudFront price class for cost optimization"
  type        = string
  default     = "PriceClass_100"
  
  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "Price class must be one of: PriceClass_100, PriceClass_200, PriceClass_All."
  }
}

variable "s3_lifecycle_enabled" {
  description = "Enable S3 lifecycle policies for cost optimization"
  type        = bool
  default     = true
}

variable "s3_ia_transition_days" {
  description = "Days before transitioning to IA storage"
  type        = number
  default     = 30
}

variable "s3_glacier_transition_days" {
  description = "Days before transitioning to Glacier storage"
  type        = number
  default     = 90
}

variable "s3_expiration_days" {
  description = "Days before deleting objects"
  type        = number
  default     = 365
}

variable "backup_expiration_days" {
  description = "Days before deleting backup objects"
  type        = number
  default     = 90
}

variable "log_retention_days_cost_optimized" {
  description = "Log retention days for cost optimization"
  type        = number
  default     = 7
}

variable "monthly_budget" {
  description = "Monthly budget limit in USD"
  type        = number
  default     = 50
}

variable "alert_email" {
  description = "Email for budget and cost alerts"
  type        = string
  default     = "admin@your-domain.com"
}

variable "enable_cost_optimization" {
  description = "Enable cost optimization features"
  type        = bool
  default     = true
}

variable "use_single_az" {
  description = "Use single availability zone for cost savings"
  type        = bool
  default     = false
}

variable "enable_auto_scaling_cost_optimized" {
  description = "Enable auto scaling with cost optimization"
  type        = bool
  default     = false
}

variable "max_capacity_cost_optimized" {
  description = "Maximum capacity for cost-optimized deployment"
  type        = number
  default     = 2
} 

# Admin email for notifications
variable "admin_email" {
  description = "Admin email address for notifications and alerts"
  type        = string
  default     = "admin@example.com"
} 

variable "hosted_zone_id" {
  description = "The Route53 hosted zone ID to use for DNS records."
  type        = string
  default     = ""
} 