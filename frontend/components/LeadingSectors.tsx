import type { LeadingSectorRow } from '@/lib/types'
import { translateSector } from '@/lib/sectorMap'

interface LeadingSectorsProps {
  marketLabel: string
  sectors: LeadingSectorRow[]
}

export function LeadingSectors({ marketLabel, sectors }: LeadingSectorsProps) {
  if (sectors.length === 0) {
    return <p className="text-xs text-muted-foreground">{marketLabel} 주도섹터 데이터가 없습니다.</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">주도섹터</span>
      {sectors
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((sector) => (
          <span
            key={sector.sector}
            className="inline-flex items-center rounded-md bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground"
          >
            {sector.rank}. {translateSector(sector.sector)}
          </span>
        ))}
    </div>
  )
}
