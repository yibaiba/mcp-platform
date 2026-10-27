import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js';
import { Button } from '../ui/button.js';
export function Disclosure({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="group h-auto justify-start px-0 text-muted-foreground"
          />
        }
      >
        <ChevronDown className="size-4 -rotate-90 group-data-panel-open:rotate-0" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="pt-4 data-closed:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
