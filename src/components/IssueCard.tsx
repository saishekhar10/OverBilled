import RiskBadge from './RiskBadge'

interface Issue {
  id: string
  type: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  title: string
  description: string
  amount_at_risk: number
  action_required: string
  deadline: string | null
  cpt_codes: string[]
}

interface IssueCardProps {
  issue: Issue
}

const amountColor: Record<Issue['severity'], string> = {
  LOW: 'text-green-700',
  MEDIUM: 'text-yellow-700',
  HIGH: 'text-orange-700',
  CRITICAL: 'text-red-700',
}

export default function IssueCard({ issue }: IssueCardProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <RiskBadge level={issue.severity} />
        <span className={`font-bold text-sm ${amountColor[issue.severity]}`}>
          ${issue.amount_at_risk.toLocaleString()} at risk
        </span>
      </div>

      <h3 className="text-gray-900 font-semibold">{issue.title}</h3>

      <p className="text-gray-600 text-sm">{issue.description}</p>

      <p className="text-gray-700 text-sm">
        <span className="font-medium">Action:</span> {issue.action_required}
      </p>

      {issue.deadline && (
        <p className="text-red-600 text-sm flex items-center gap-1">
          <span>⚠</span>
          <span>Deadline: {issue.deadline}</span>
        </p>
      )}

      {issue.cpt_codes.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          <span className="text-gray-500 text-xs mr-1">CPT codes:</span>
          {issue.cpt_codes.map((code, index) => (
            <span
              key={`${code}-${index}`}
              className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full"
            >
              {code}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
