import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import generateResponse from '../utility/responseFormat.js';
import Category from '../models/category.model.js';

// Create category
export const createCategory = catchAsync(async (req, res, next) => {
  const { name, displayName, description } = req.body;

  if (!name || !displayName) {
    return next(new AppError('Name and display name are required', 400));
  }

  // Convert name to lowercase and replace spaces with underscores
  const categoryName = name.trim().toLowerCase().replace(/\s+/g, '_');

  // Check if category already exists
  const existingCategory = await Category.findOne({ name: categoryName });
  if (existingCategory) {
    return next(new AppError('Category already exists', 409));
  }

  const category = await Category.create({
    name: categoryName,
    displayName: displayName.trim(),
    description: description?.trim(),
    createdBy: req.user._id,
  });

  const response = generateResponse(
    'Success',
    'Category created successfully',
    category,
    undefined
  );

  return res.status(201).json(response);
});

// Get all categories
export const getAllCategories = catchAsync(async (req, res, next) => {
  const { isActive, search } = req.query;

  const query = {};
  if (isActive !== undefined && isActive !== '') {
    query.isActive = isActive === 'true' || isActive === true;
  }
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { displayName: { $regex: search, $options: 'i' } },
    ];
  }

  const categories = await Category.find(query)
    .sort({ displayName: 1 })
    .select('-__v')
    .lean();

  const response = generateResponse(
    'Success',
    'Categories fetched successfully',
    categories,
    undefined
  );

  return res.status(200).json(response);
});

// Get category by ID
export const getCategoryById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const category = await Category.findById(id).populate('createdBy', 'name email');

  if (!category) {
    return next(new AppError('Category not found', 404));
  }

  const response = generateResponse(
    'Success',
    'Category fetched successfully',
    category,
    undefined
  );

  return res.status(200).json(response);
});

// Update category
export const updateCategory = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { displayName, description, isActive } = req.body;

  const category = await Category.findById(id);

  if (!category) {
    return next(new AppError('Category not found', 404));
  }

  if (displayName) category.displayName = displayName.trim();
  if (description !== undefined) category.description = description?.trim();
  if (isActive !== undefined) category.isActive = isActive;
  category.updatedBy = req.user._id;

  await category.save();

  const response = generateResponse(
    'Success',
    'Category updated successfully',
    category,
    undefined
  );

  return res.status(200).json(response);
});

// Delete category
export const deleteCategory = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const category = await Category.findById(id);

  if (!category) {
    return next(new AppError('Category not found', 404));
  }

  // Check if category is being used by any products
  const Product = (await import('../models/product.model.js')).default;
  const productCount = await Product.countDocuments({ category: category.name });

  if (productCount > 0) {
    return next(
      new AppError(
        `Cannot delete category. It is being used by ${productCount} product(s)`,
        400
      )
    );
  }

  await Category.findByIdAndDelete(id);

  const response = generateResponse(
    'Success',
    'Category deleted successfully',
    null,
    undefined
  );

  return res.status(200).json(response);
});

