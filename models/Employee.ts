import mongoose, { Document, Schema } from 'mongoose';

export interface IEmployee extends Document {
  name: string;
  designation: string;
  /** Home / primary department (always a single value). */
  department: string;
  employeeId?: string;
  /** Date the employee joined the organisation. */
  dateOfJoining?: Date;
  /** When true, the employee must complete induction-training SOPs. */
  inductionTrainingRequired: boolean;
  /** When true, the employee is designated as a trainer. */
  isTrainer: boolean;
  /**
   * Departments this trainer is eligible to manage (SOPs / training matrix).
   * Only meaningful when isTrainer is true. Empty → fall back to `department`.
   */
  trainerDepartments: string[];
  isActive: boolean;
  /** Auto-generated login handle for the learning module. */
  lmsUsername?: string;
  /** bcrypt hash of the learning-module password (never returned to the client). */
  lmsPasswordHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmployeeSchema = new Schema<IEmployee>(
  {
    name:        { type: String, required: true, trim: true },
    designation: { type: String, required: true, trim: true },
    department:  { type: String, required: true, trim: true, index: true },
    employeeId:  { type: String, trim: true },
    dateOfJoining: { type: Date },
    inductionTrainingRequired: { type: Boolean, default: false, index: true },
    isTrainer:   { type: Boolean, default: false, index: true },
    trainerDepartments: {
      type: [String],
      default: [],
      index: true,
    },
    isActive:    { type: Boolean, default: true, index: true },
    // Casing is preserved (e.g. "Abbas.Mehdi"); login matches case-insensitively.
    lmsUsername: { type: String, trim: true, unique: true, sparse: true },
    // select:false keeps the hash out of every normal query result.
    lmsPasswordHash: { type: String, select: false },
  },
  { timestamps: true },
);

EmployeeSchema.index({ department: 1, isActive: 1 });

// Hot-reload safe: if Employee was compiled before trainerDepartments existed,
// strict mode would silently drop $set of that path. Ensure paths are present.
function getEmployeeModel() {
  const existing = mongoose.models.Employee as mongoose.Model<IEmployee> | undefined;
  if (existing) {
    if (!existing.schema.path('isTrainer')) {
      existing.schema.add({ isTrainer: { type: Boolean, default: false, index: true } });
    }
    if (!existing.schema.path('trainerDepartments')) {
      existing.schema.add({
        trainerDepartments: { type: [String], default: [], index: true },
      });
    }
    return existing;
  }
  return mongoose.model<IEmployee>('Employee', EmployeeSchema);
}

export default getEmployeeModel();
